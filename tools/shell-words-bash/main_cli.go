//go:build !(js && wasm)

package main

import (
	"fmt"
	"io"
	"os"
)

// The native build reads the command on stdin, for checking the reader without Node.
func main() {
	source, err := io.ReadAll(os.Stdin)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	fmt.Println(encode(shellWords(string(source))))
}
