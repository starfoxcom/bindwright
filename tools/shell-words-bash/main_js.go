//go:build js && wasm

package main

import "syscall/js"

func main() {
	input := js.Global().Get("shellWordsInput").String()
	js.Global().Set("shellWordsOutput", encode(shellWords(input)))
}
