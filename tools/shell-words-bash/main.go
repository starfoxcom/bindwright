// Command shell-words-bash reads a bash command with mvdan.cc/sh's parser and reports each simple
// command's words and each variable the command sets, for the attribution guard.
//
// It runs once inside Node as WebAssembly (GOOS=js GOARCH=wasm): the caller sets the global
// `shellWordsInput` to the command, runs the module, and reads the global `shellWordsOutput`, a
// JSON object {"error": bool, "commands": [[word, ...], ...], "assignments": [{"name", "value"}]}.
// A word is a string, or {"dynamic": <source text>} when the shell builds it at run time.
package main

import (
	"encoding/json"
	"regexp"
	"slices"
	"strings"

	"mvdan.cc/sh/v3/syntax"
)

type assignment struct {
	Name  string `json:"name"`
	Value any    `json:"value"`
}

type result struct {
	Error       bool         `json:"error"`
	Commands    [][]any      `json:"commands"`
	Assignments []assignment `json:"assignments"`
}

type dynamic struct {
	Dynamic string `json:"dynamic"`
}

var (
	unquotedEscape = regexp.MustCompile(`(?s)\\(.)`)
	quotedEscape   = regexp.MustCompile("\\\\([$`\"\\\\\n])")
)

// unescape reads backslash escapes left to right, as bash does: a backslash before a newline
// joins the lines, before any other character it matched it keeps that character.
func unescape(escape *regexp.Regexp, text string) string {
	return escape.ReplaceAllStringFunc(text, func(match string) string {
		if match[1:] == "\n" {
			return ""
		}
		return match[1:]
	})
}

// reader turns words into their literal values, keeping the source to quote dynamic ones.
type reader struct {
	source string
}

func (r reader) text(node syntax.Node) string {
	return r.source[node.Pos().Offset():node.End().Offset()]
}

func (r reader) dynamicWord(node syntax.Node) dynamic {
	return dynamic{Dynamic: r.text(node)}
}

// word is the literal value bash gives the word, or a dynamic marker when any part of it is
// expanded at run time: a parameter, a substitution, a glob, a brace expansion, or an ANSI-C or
// locale string.
func (r reader) word(word *syntax.Word) any {
	// Bash's own rule: only a brace holding a comma or a range expands (`{a,b}`, `{1..3}`), never
	// `{}` or `stash@{0}`. The parser splits a copy, since it rewrites the parts it is given, and
	// turns a brace that does not expand back into plain text.
	split := &syntax.Word{Parts: slices.Clone(word.Parts)}
	syntax.SplitBraces(split)
	if slices.ContainsFunc(split.Parts, func(part syntax.WordPart) bool {
		_, expands := part.(*syntax.BraceExp)
		return expands
	}) || isGlob(word) {
		return r.dynamicWord(word)
	}
	var value strings.Builder
	for _, part := range word.Parts {
		literal, ok := r.literalPart(part)
		if !ok {
			return r.dynamicWord(word)
		}
		value.WriteString(literal)
	}
	return value.String()
}

func (r reader) literalPart(part syntax.WordPart) (string, bool) {
	switch part := part.(type) {
	case *syntax.Lit:
		return unescape(unquotedEscape, part.Value), true
	case *syntax.SglQuoted:
		return part.Value, !part.Dollar
	case *syntax.DblQuoted:
		if part.Dollar {
			return "", false
		}
		var value strings.Builder
		for _, inner := range part.Parts {
			lit, ok := inner.(*syntax.Lit)
			if !ok {
				return "", false
			}
			value.WriteString(unescape(quotedEscape, lit.Value))
		}
		return value.String(), true
	}
	return "", false
}

// isGlob reports whether bash can expand the word as a file pattern: an unquoted `*` or `?`, or
// an unquoted `[` with an unquoted `]` after it, wherever quotes split them (`ms["g"]` is the
// pattern `ms[g]`). A lone `[`, the test command, stays itself.
func isGlob(word *syntax.Word) bool {
	open := false
	for _, part := range word.Parts {
		lit, unquoted := part.(*syntax.Lit)
		if !unquoted {
			continue
		}
		for _, char := range lit.Value {
			switch {
			case char == '*' || char == '?' || char == ']' && open:
				return true
			case char == '[':
				open = true
			}
		}
	}
	return false
}

func (r reader) assignment(assign *syntax.Assign) assignment {
	var value any = ""
	if assign.Value != nil {
		value = r.word(assign.Value)
	}
	return assignment{Name: assign.Name.Value, Value: value}
}

// shellWords reads every simple command in source order, nested ones included. An array is
// unreadable: its words reach a command later, wherever it runs.
func shellWords(source string) result {
	out := result{Commands: [][]any{}, Assignments: []assignment{}}
	parser := syntax.NewParser(syntax.Variant(syntax.LangBash), syntax.KeepComments(true))
	file, err := parser.Parse(strings.NewReader(source), "")
	if err != nil {
		out.Error = true
		return out
	}
	r := reader{source: source}
	addAssigns := func(assigns []*syntax.Assign) {
		for _, assign := range assigns {
			if assign.Array != nil {
				out.Error = true
			}
			switch {
			case assign.Name != nil && !assign.Naked:
				out.Assignments = append(out.Assignments, r.assignment(assign))
			case assign.Naked && assign.Value != nil:
				// `export "A=1"` reaches the parser as one word, which bash splits at its first `=`;
				// a word built at run time could set any variable.
				if word, literal := r.word(assign.Value).(string); !literal {
					out.Error = true
				} else if name, value, sets := strings.Cut(word, "="); sets {
					out.Assignments = append(out.Assignments, assignment{Name: name, Value: value})
				}
			}
		}
	}
	syntax.Walk(file, func(node syntax.Node) bool {
		switch node := node.(type) {
		case *syntax.CallExpr:
			addAssigns(node.Assigns)
			if len(node.Args) > 0 {
				words := make([]any, len(node.Args))
				for i, arg := range node.Args {
					words[i] = r.word(arg)
				}
				out.Commands = append(out.Commands, words)
			}
		case *syntax.DeclClause:
			addAssigns(node.Args)
		case *syntax.ArrayExpr:
			out.Error = true
		case *syntax.Comment:
			// Bash ends a comment at the newline even after a backslash; this parser takes the
			// next line into the comment, so the commands on it would go unread.
			if strings.Contains(r.text(node), "\\\n") || strings.HasSuffix(node.Text, "\\") {
				out.Error = true
			}
		}
		return true
	})
	return out
}

func encode(out result) string {
	encoded, err := json.Marshal(out)
	if err != nil {
		return `{"error":true,"commands":[],"assignments":[]}`
	}
	return string(encoded)
}
