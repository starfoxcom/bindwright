---
name: verify
description: See a change work in the running app before it is committed. Starts <project>, drives it to the changed part and checks what it shows. Use before each commit of a change people can see or use, and whenever asked to verify, run or check the app.
---

# /verify

The tests prove the code. This proves the change works where people use it.

## 1. Start it

<The command that starts the app, where it runs (a URL and port, a window, a device or simulator), and the line or sign that says it is ready. A server or watcher runs in the background so the next steps can reach it.>

## 2. Drive it to the change

<How to reach the part a change touches: the route or screen, the command and its arguments, the input or test data to use (test accounts by placeholder name, never a real password). For a web page, a browser tool the session has, such as Claude in Chrome.>

## 3. Look

<What to check: the changed screen or output does what the change says, with no errors in the log or the browser console. For a web page, also run the layout check: `node "$HOME/.bindwright/helper/node_modules/bindwright/hooks/layout-check.mjs" <page URL>`.>

## 4. Stop and report

Stop what step 1 started. Report what was seen, with the route or command and a screenshot or log line where it applies. A failure is reported as a failure, and the change is not committed until it passes or the user says to go ahead.
