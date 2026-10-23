Output "packages/ofdrw-viewer-cli/demo/demo.gif"

Set Shell "bash"
Set FontFamily "Noto Sans Mono CJK SC"
Set FontSize 15
Set Width 1200
Set Height 720
Set Padding 24
Set Theme "Catppuccin Mocha"
Set TypingSpeed 50ms

Hide
Type "PS1='$ '"
Enter
Type "mkdir -p /tmp/ofdrw-viewer-cli-demo-bin && ln -sf $PWD/packages/ofdrw-viewer-cli/dist/bin.js /tmp/ofdrw-viewer-cli-demo-bin/ofdrw-viewer-cli && export PATH=/tmp/ofdrw-viewer-cli-demo-bin:$PATH"
Enter
Type "cp $PWD/ofd_pdf_match/dense-text-perf.ofd /tmp/input.ofd && cd /tmp && rm -rf output"
Enter
Sleep 1s
Type "clear"
Enter
Sleep 500ms
Show

Type "ofdrw-viewer-cli input.ofd -o output"
Enter
Sleep 3s

Type "ls -a output"
Enter
Sleep 3s
