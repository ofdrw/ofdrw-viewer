Output "packages/ofdrw-viewer-cli/docs/img/demo.gif"

Set Shell "bash"
Set FontFamily "Noto Sans Mono CJK SC"
Set FontSize 22
Set Width 620
Set Height 400
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Set CursorBlink false

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
Sleep 2s