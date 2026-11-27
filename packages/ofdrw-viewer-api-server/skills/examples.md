# 调用示例

各语言示例统一使用 **JSON + base64** 模式（`Content-Type: application/json`），只依赖语言标准库，不引入第三方包。把 `BASE` 换成实际地址（默认 `http://127.0.0.1:7860/api`），`input.ofd` 换成待处理文档路径。

请求体结构固定为：

```json
{ "file": { "name": "input.ofd", "base64": "<文件内容>" }, "params": { "pages": "1-3", "dpi": 150 } }
```

`params` 中各接口可用字段见 [API.md](../docs/API.md)。表单模式（`multipart/form-data`，文档走 `file` 字段、参数平铺）在 curl 与各语言中均可替代 JSON 模式，参数完全一致。

## 目录

- [curl](#curl)
- [Python](#python)
- [JavaScript / TypeScript](#javascript--typescript)
- [Java](#java)
- [C#](#c)
- [Go](#go)

## curl

```bash
BASE=http://127.0.0.1:7860/api

# 健康检查
curl -s "$BASE/health"

# 转前 3 页为 PNG（JSON 模式，图片为 base64）
curl -s -X POST "$BASE/convert" -H 'Content-Type: application/json' \
  -d "{\"file\":{\"name\":\"input.ofd\",\"base64\":\"$(base64 -w0 input.ofd)\"},\"params\":{\"pages\":\"1-3\",\"dpi\":150}}" \
  | jq -r '.pages[0].image' | base64 -d > p001.png

# 或直接用表单模式，单页图片以二进制流写盘
curl -s -X POST "$BASE/pages" -F file=@input.ofd -F page=1 -F dpi=150 -o p001.png

# 文字坐标
curl -s -X POST "$BASE/text" -F file=@input.ofd > text.json

# 提交作业，记下 jobId
JOB=$(curl -s -X POST "$BASE/jobs" -F file=@input.ofd -F ops=images,text -F ttlSec=3600 \
  | sed -n 's/.*"jobId":"\([^"]*\)".*/\1/p')

# 轮询状态（建议每 1–2 秒一次），直到 status 为 done/failed/cancelled/interrupted
curl -s "$BASE/jobs/$JOB/meta.json"

# 取整包后释放
curl -s -o "$JOB.zip" "$BASE/jobs/$JOB/result"
curl -s -X DELETE "$BASE/jobs/$JOB"

# 验签，结论看 overall
curl -s -X POST "$BASE/verify" -F file=@signed.ofd -F roots=@root-ca.pem | jq -r '.overall'
```

## Python

用 `urllib`（标准库）构造 JSON 请求，`json` 解析响应，`pathlib` 写盘。

```python
import base64
import json
import time
import urllib.request
from pathlib import Path

BASE = "http://127.0.0.1:7860/api"


def post(path: str, params: dict | None = None, file_path: str | None = None) -> dict:
    """向 BASE+path 发 JSON POST，返回解析后的响应体。

    Args:
        path: 接口路径，如 "/convert"。
        params: 业务参数，放入请求体 params 字段。
        file_path: OFD 文档路径；为空时不携带文档。
    Returns:
        响应体 JSON 对象。
    Raises:
        urllib.error.HTTPError: 非 2xx 响应，可从 e.read() 取错误体。
    """
    body = {"params": params or {}}
    if file_path:
        body["file"] = {
            "name": Path(file_path).name,
            "base64": base64.b64encode(Path(file_path).read_bytes()).decode(),
        }
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


# 转前 3 页并写盘
result = post("/convert", {"pages": "1-3", "dpi": 150}, "input.ofd")
for page in result["pages"]:
    Path(f"p{page['page']:03d}.png").write_bytes(base64.b64decode(page["image"]))

# 文字坐标（单位 px）
for page in post("/text", {"pages": "1"}, "input.ofd")["pages"]:
    for item in page["items"]:
        print(page["page"], item["text"], item["x"], item["y"], item["w"], item["h"])

# 作业提交与轮询
job_id = post("/jobs", {"ops": "images,text", "ttlSec": 3600}, "input.ofd")["jobId"]
while True:
    meta = json.load(urllib.request.urlopen(f"{BASE}/jobs/{job_id}/meta.json"))
    if meta["status"] in ("done", "failed", "cancelled", "interrupted"):
        break
    time.sleep(1.5)
print(meta["status"], meta["progress"])

# 取整包 ZIP
with urllib.request.urlopen(f"{BASE}/jobs/{job_id}/result") as resp:
    Path(f"{job_id}.zip").write_bytes(resp.read())

# 验签，结论看 overall
print(post("/verify", {}, "signed.ofd")["overall"])
```

## JavaScript / TypeScript

Node.js 18+ 内置 `fetch` 与 `FormData`/`Blob`，浏览器中对 OFD 用 `File` 对象走表单模式即可。

```ts
import { readFile, writeFile } from "node:fs/promises";

const BASE = "http://127.0.0.1:7860/api";

/** 以表单模式 POST，返回解析后的 JSON。 */
async function post(path: string, file: Blob, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("file", file);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(BASE + path, { method: "POST", body: form });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const doc = new Blob([await readFile("input.ofd")]);

// 转图：图片为 base64
const { pages } = await post("/convert", doc, { pages: "1-3", dpi: "150" });
for (const p of pages) {
  await writeFile(`p${String(p.page).padStart(3, "0")}.png`, Buffer.from(p.image, "base64"));
}

// 文字坐标（单位 px）
const text = await post("/text", doc, { pages: "1" });
for (const page of text.pages)
  for (const it of page.items) console.log(page.page, it.text, it.x, it.y, it.w, it.h);

// 作业提交与轮询
const { jobId } = await post("/jobs", doc, { ops: "images,text", ttlSec: "3600" });
let meta: any;
do {
  meta = await (await fetch(`${BASE}/jobs/${jobId}/meta.json`)).json();
  if (!["done", "failed", "cancelled", "interrupted"].includes(meta.status))
    await new Promise((r) => setTimeout(r, 1500));
} while (!["done", "failed", "cancelled", "interrupted"].includes(meta.status));

// 取整包 ZIP
const zip = await fetch(`${BASE}/jobs/${jobId}/result`);
await writeFile(`${jobId}.zip`, Buffer.from(await zip.arrayBuffer()));

// 验签，结论看 overall
console.log((await post("/verify", doc)).overall);
```

> 示例按 Node.js 编写。浏览器中把 `readFile`/`writeFile` 换成 `<input type="file">` 得到的 `File` 与 `URL.createObjectURL(blob)` 下载即可，`post` 函数无需改动。

## Java

JDK 8+ 可用的 `HttpURLConnection` + `java.util.Base64`，无需额外依赖。

```java
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.UnsupportedEncodingException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class OfdClient {
    static final String BASE = "http://127.0.0.1:7860/api";
    static final Pattern JOB_ID = Pattern.compile("\"jobId\"\\s*:\\s*\"([^\"]+)\"");
    static final Pattern IMAGE = Pattern.compile("\"image\"\\s*:\\s*\"([^\"]+)\"");

    /**
     * 以 JSON + base64 模式 POST，返回响应文本。
     *
     * @param path       接口路径，如 "/convert"
     * @param doc        待处理文档，可为 null（不携带文档）
     * @param paramsJson 已拼好的 params JSON 片段
     * @return 响应体文本
     * @throws IOException 非 2xx 响应时抛出，消息含状态码与响应体
     */
    static String post(String path, Path doc, String paramsJson) throws IOException {
        StringBuilder body = new StringBuilder("{\"params\":").append(paramsJson);
        if (doc != null) {
            body.append(",\"file\":{\"name\":\"").append(doc.getFileName())
                .append("\",\"base64\":\"")
                .append(Base64.getEncoder().encodeToString(Files.readAllBytes(doc)))
                .append("\"}");
        }
        body.append('}');
        return request("POST", path, body.toString());
    }

    /** GET 指定路径并返回响应文本。 */
    static String get(String path) throws IOException {
        return request("GET", path, null);
    }

    /** 发一次请求并把响应体读成 UTF-8 文本；非 2xx 抛 IOException。 */
    static String request(String method, String path, String jsonBody) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(BASE + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(10000);
        conn.setReadTimeout(120000);
        if (jsonBody != null) {
            byte[] bytes = jsonBody.getBytes(StandardCharsets.UTF_8);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("Content-Length", String.valueOf(bytes.length));
            OutputStream out = conn.getOutputStream();
            try {
                out.write(bytes);
            } finally {
                out.close();
            }
        }
        int status = conn.getResponseCode();
        InputStream in = status / 100 == 2 ? conn.getInputStream() : conn.getErrorStream();
        String text = readAll(in);
        conn.disconnect();
        if (status / 100 != 2) {
            throw new IOException(status + " " + text);
        }
        return text;
    }

    /** 读尽输入流并按 UTF-8 解码；in 为 null 时返回空串。 */
    static String readAll(InputStream in) throws IOException {
        if (in == null) {
            return "";
        }
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        try {
            while ((n = in.read(chunk)) != -1) {
                buf.write(chunk, 0, n);
            }
        } finally {
            in.close();
        }
        return new String(buf.toByteArray(), StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        Path doc = Paths.get("input.ofd");

        // 转图并写盘（示例只取第一页，完整遍历 pages 数组需 JSON 库）
        String convert = post("/convert", doc, "{\"pages\":\"1-3\",\"dpi\":150}");
        Matcher image = IMAGE.matcher(convert);
        if (image.find()) {
            Files.write(Paths.get("p001.png"), Base64.getDecoder().decode(image.group(1)));
        }

        // 文字坐标
        System.out.println(post("/text", doc, "{\"pages\":\"1\"}"));

        // 作业提交与轮询
        Matcher job = JOB_ID.matcher(post("/jobs", doc, "{\"ops\":\"images,text\",\"ttlSec\":3600}"));
        if (!job.find()) {
            throw new IllegalStateException("未返回 jobId");
        }
        String jobId = job.group(1);
        while (true) {
            String meta = get("/jobs/" + jobId + "/meta.json");
            if (meta.contains("\"status\":\"done\"") || meta.contains("\"failed\"")
                    || meta.contains("\"cancelled\"") || meta.contains("\"interrupted\"")) {
                System.out.println(meta);
                break;
            }
            Thread.sleep(1500);
        }

        // 取整包 ZIP
        HttpURLConnection zip = (HttpURLConnection) new URL(BASE + "/jobs/" + jobId + "/result").openConnection();
        try {
            Files.copy(zip.getInputStream(), Paths.get(jobId + ".zip"));
        } finally {
            zip.disconnect();
        }

        // 验签，结论看 overall
        System.out.println(post("/verify", Paths.get("signed.ofd"), "{}"));
    }
}
```

> 生产代码建议引入 Jackson 或 Gson 解析 `pages[]`、`overall` 等结构化字段，上面的正则只为演示最小依赖。JDK 8 不要用已废弃的 `sun.misc.BASE64Encoder`，统一用 `java.util.Base64`；JDK 11+ 可改用 `java.net.http.HttpClient`。

## C#

.NET 的 `HttpClient` + `System.Text.Json`，同步转图用强类型反序列化。

```csharp
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

using var http = new HttpClient { BaseAddress = new Uri("http://127.0.0.1:7860/api/") };

// 服务端字段为小写开头（page、text、overall 等），须用不区分大小写的命名策略
var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

async Task<string> PostAsync(string path, string docPath, string paramsJson)
{
    var body = new StringBuilder("{")
        .Append("\"file\":{\"name\":\"").Append(Path.GetFileName(docPath))
        .Append("\",\"base64\":\"")
        .Append(Convert.ToBase64String(await File.ReadAllBytesAsync(docPath)))
        .Append("\"},\"params\":").Append(paramsJson).Append('}').ToString();
    var res = await http.PostAsync(path,
        new StringContent(body, Encoding.UTF8, "application/json"));
    res.EnsureSuccessStatusCode();
    return await res.Content.ReadAsStringAsync();
}

// 转图：pages[].image 为 base64
var convert = JsonSerializer.Deserialize<ConvertResult>(
    await PostAsync("convert", "input.ofd", "{\"pages\":\"1-3\",\"dpi\":150}"), json)!;
foreach (var p in convert.Pages)
    await File.WriteAllBytesAsync($"p{p.Page:D3}.png", Convert.FromBase64String(p.Image));

// 文字坐标（单位 px）
var text = JsonSerializer.Deserialize<TextResult>(
    await PostAsync("text", "input.ofd", "{\"pages\":\"1\"}"), json)!;
foreach (var page in text.Pages)
    foreach (var it in page.Items)
        Console.WriteLine($"{page.Page} {it.Text} {it.X} {it.Y} {it.W} {it.H}");

// 作业提交与轮询
var job = JsonSerializer.Deserialize<JobCreated>(
    await PostAsync("jobs", "input.ofd", "{\"ops\":\"images,text\",\"ttlSec\":3600}"), json)!;
JobMeta meta;
do
{
    await Task.Delay(1500);
    meta = (await http.GetFromJsonAsync<JobMeta>($"jobs/{job.JobId}/meta.json", json))!;
} while (meta.Status is "queued" or "running");

// 取整包 ZIP
await File.WriteAllBytesAsync($"{job.JobId}.zip",
    await http.GetByteArrayAsync($"jobs/{job.JobId}/result"));

// 验签，结论看 overall
var report = JsonSerializer.Deserialize<VerifyReport>(
    await PostAsync("verify", "signed.ofd", "{}"), json)!;
Console.WriteLine(report.Overall);

record ConvertResult(List<PageImage> Pages);
record PageImage(int Page, string Image);
record TextResult(List<TextPage> Pages);
record TextPage(int Page, List<TextItem> Items);
record TextItem(string Text, double X, double Y, double W, double H);
record JobCreated([property: JsonPropertyName("jobId")] string JobId);
record JobMeta(string Status);
record VerifyReport(string Overall);
```

## Go

标准库 `net/http` + `encoding/json` + `encoding/base64`。

```go
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

const base = "http://127.0.0.1:7860/api"

// post 以 JSON + base64 模式发送请求；docPath 为空时不携带文档。
func post(path, docPath string, params map[string]any) ([]byte, error) {
	body := map[string]any{"params": params}
	if docPath != "" {
		raw, err := os.ReadFile(docPath)
		if err != nil {
			return nil, err
		}
		body["file"] = map[string]string{
			"name":   docPath,
			"base64": base64.StdEncoding.EncodeToString(raw),
		}
	}
	buf, _ := json.Marshal(body)
	resp, err := http.Post(base+path, "application/json", bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		return nil, fmt.Errorf("%d %s", resp.StatusCode, data)
	}
	return data, nil
}

func main() {
	// 转图：pages[].image 为 base64
	type pageImage struct {
		Page  int    `json:"page"`
		Image string `json:"image"`
	}
	var conv struct{ Pages []pageImage }
	data, err := post("/convert", "input.ofd", map[string]any{"pages": "1-3", "dpi": 150})
	if err != nil {
		panic(err)
	}
	json.Unmarshal(data, &conv)
	for _, p := range conv.Pages {
		img, _ := base64.StdEncoding.DecodeString(p.Image)
		os.WriteFile(fmt.Sprintf("p%03d.png", p.Page), img, 0o644)
	}

	// 文字坐标（单位 px）
	type item struct {
		Text string  `json:"text"`
		X    float64 `json:"x"`
		Y    float64 `json:"y"`
		W    float64 `json:"w"`
		H    float64 `json:"h"`
	}
	var txt struct {
		Pages []struct {
			Page  int    `json:"page"`
			Items []item `json:"items"`
		} `json:"pages"`
	}
	data, _ = post("/text", "input.ofd", map[string]any{"pages": "1"})
	json.Unmarshal(data, &txt)
	for _, p := range txt.Pages {
		for _, it := range p.Items {
			fmt.Println(p.Page, it.Text, it.X, it.Y, it.W, it.H)
		}
	}

	// 作业提交与轮询
	var job struct {
		JobID string `json:"jobId"`
	}
	data, err = post("/jobs", "input.ofd", map[string]any{"ops": "images,text", "ttlSec": 3600})
	if err != nil {
		panic(err)
	}
	json.Unmarshal(data, &job)
	var meta struct {
		Status   string `json:"status"`
		Progress struct {
			Done  int `json:"done"`
			Total int `json:"total"`
		} `json:"progress"`
	}
	for {
		resp, err := http.Get(base + "/jobs/" + job.JobID + "/meta.json")
		if err != nil {
			panic(err)
		}
		data, _ = io.ReadAll(resp.Body)
		resp.Body.Close()
		json.Unmarshal(data, &meta)
		if meta.Status != "queued" && meta.Status != "running" {
			break
		}
		time.Sleep(1500 * time.Millisecond)
	}
	fmt.Println(meta.Status, meta.Progress.Done, meta.Progress.Total)

	// 取整包 ZIP
	resp, err := http.Get(base + "/jobs/" + job.JobID + "/result")
	if err != nil {
		panic(err)
	}
	defer resp.Body.Close()
	out, _ := os.Create(job.JobID + ".zip")
	defer out.Close()
	io.Copy(out, resp.Body)

	// 验签，结论看 overall
	var report struct {
		Overall string `json:"overall"`
	}
	data, err = post("/verify", "signed.ofd", map[string]any{})
	if err != nil {
		panic(err)
	}
	json.Unmarshal(data, &report)
	fmt.Println(report.Overall)
}
```