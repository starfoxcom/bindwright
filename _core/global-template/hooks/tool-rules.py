#!/usr/bin/env python3
"""PreToolUse guard: refuse the shell patterns a session was told to stop using.

Each rule in RULES names a pattern that keeps failing, why, and what to use
instead. A correction of the kind "never use X, use Y" lands here as a new rule,
so the session cannot drift back to X: a note in memory alone does not hold.

Rules other than the inline-script one read the command with quoted strings
and PowerShell here-string bodies taken out, and a bash command only as far as
its first here-document, so a commit message or a PR body that only mentions a
pattern passes. The inline-script rule reads a bash command's first
here-document, only when its `<<` stands outside quotes, and PowerShell
here-strings, and refuses one only where an interpreter reads its script from
standard input (`python -`, `cat <<EOF | node`): fed to a script file, the text
is data. It also reads the script of a `python -c` or `node -e` call that
stands outside quotes and comments. The length rules read a plain Bash command
(no expansion or escape) split into words as Bash splits it,
and take the first `-m` of a `git commit` or the `--title` of `gh pr create` or
`edit`. Where the reading is unsure (a quote that
never closes, a double-quoted string holding `$(`, a `<<` inside one), the
text is left unread: a missed pattern costs less than a refused command. It is
a safety net for the ordinary spelling, not a sandbox against a command built
to slip past it.

Each rule carries its mode. An `enforce` rule refuses the command. An `observe`
rule only appends what it would have refused to the user's Bindwright folder
(OBSERVED_LOG), which `/bindwright:doctor` reports, so a false refusal shows up
before anyone is stopped. A new rule ships as `observe` and moves to `enforce`
in a later release once its log shows none, unless the command it stops cannot
be undone (a repo secret write): that one enforces from the start. The mode
lives here, never in a file a session could write, so nothing at run time
relaxes a rule.

Exit contract: JSON permissionDecision=deny on stdout, exit 0. Silent exit 0
otherwise, and for any input it cannot read.
"""
import bisect
import collections
import json
import os
import re
import shlex
import sys
import time

INTERPRETER = r"(?:python3?|py|node|deno|bun|perl|ruby|php|bash|sh|zsh|pwsh|powershell)(?:\.exe)?"
PROGRAM = re.compile(r"(?:.*[/\\])?" + INTERPRETER, re.I)
# The short-option letters that hand each interpreter its script some other way (`python -Ic`,
# `perl -ne`, `php -r`), so standard input is data; short letters are never abbreviated.
SCRIPT_LETTERS = {"python": "cm", "py": "cm", "node": "ep", "bun": "e", "perl": "eE", "ruby": "e",
                  "php": "rf", "bash": "c", "sh": "c", "zsh": "c"}
SCRIPT_LONG = {"--eval", "--print", "--command", "--file"}
POWERSHELL_SCRIPT = {"-c", "-command", "-f", "-file", "-e", "-ec", "-encodedcommand"}
SHELLS = ("bash", "sh", "zsh")
REDIRECTION = re.compile(r"\d*(?:&>|[<>]&?)")
# A here-document opener, its word quoted (`<<'EOF'`, `<<"EOF"`), escaped (`<<\EOF`) or bare.
HEREDOC = re.compile(r"<<(-?)[ \t]*\\?(['\"]?)([A-Za-z_][\w-]*)\2")
# A `<<` that is not part of a here-string (`<<<`); `without_arithmetic` blanks arithmetic, where a
# `<<` opens nothing.
HEREDOC_OPERATOR = re.compile(r"(?<!<)<<(?!<)")
# A PowerShell here-string: `@'` or `@"` and any blanks to the end of the line, the body (none when
# the closing line comes next), then the first line that starts with the same quote and `@`.
HERE_STRING_PARTS = r"@({quotes})[ \t]*\r?\n(?:(.*?)\r?\n)??\1@"
HERE_STRING = re.compile(HERE_STRING_PARTS.format(quotes="['\"]") + r"([^\n]*)", re.S)
# The separators between the commands of one line, a lone `&` (run in the background) among them
# but not a redirection (`2>&1`, `&>f`) or `|&`; a pipe joins two parts of one command.
LIST_SEPARATOR = re.compile(r"&&|\|\||;|(?<![>&|])&(?![>&])")
# `python -c '...'`, `node -e "..."`: the script text, as far as its closing quote.
INLINE = re.compile(r"(?:^|[\s;&|(])(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c[ \t]+(['\"])(.*?)\1"
                    r"|(?:^|[\s;&|(])node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print)[ \t]+(['\"])(.*?)\3",
                    re.I | re.S)
INLINE_CALL = re.compile(r"(?:^|[\s;&|(])(?:(?:python3?|py)(?:\.exe)?(?:[ \t]+-\w+)*[ \t]+-c"
                         r"|node(?:\.exe)?(?:[ \t]+-\S+)*?[ \t]+(?:-e|-p|--eval|--print))[ \t]+['\"]", re.I)
# Comments, quoted strings and escapes as each shell reads them, in one pass across lines, so
# whichever starts first wins: a `#` that starts a word outside quotes comments out the rest of
# its line, and a quote character in a comment opens nothing. Bash escapes with a backslash,
# PowerShell with a backtick and by doubling the quote, and a PowerShell backslash is plain text
# (`"C:\"`). A PowerShell block comment runs from `<#` to the first `#>`. Bash's `$'...'` ends
# only at an unescaped quote. A quote or block comment that never closes, and a double-quoted
# string holding `$(`, whose own quotes nest, run to the end of the command. A PowerShell
# here-string (`@'` to a line starting `'@`) is one more quoted string in the same scan, so one
# inside a message or a comment is part of that text.
COMMENT = r"(?:^|(?<=[\s;&|(]))#[^\n]*"
QUOTED = {"bash": re.compile(COMMENT + r"|\\.|\$'(?:[^'\\]|\\.)*(?:'|\Z)|'[^']*(?:'|\Z)"
                             r"|\"(?:[^\"\\$]|\\.|\$(?!\())*\$\(.*|\"(?:[^\"\\]|\\.)*(?:\"|\Z)", re.S)}
POWERSHELL_QUOTED = (r"<#.*?(?:#>|\Z)|" + COMMENT + r"|`.|'(?:[^']|'')*(?:'|\Z)"
                     r"|\"(?:[^\"`$]|`.|\"\"|\$(?!\())*\$\(.*|\"(?:[^\"`]|`.|\"\")*(?:\"|\Z)")
# The PowerShell scan for each set of quotes whose here-strings may still close. An opener with
# no closing line after it never matches, and trying one reads to the end of the command, so the
# scan leaves those out: many of them would take time that grows with the command's length squared.
POWERSHELL_SCANS = {quotes: re.compile((HERE_STRING_PARTS.format(quotes="[%s]" % quotes) + "|" if quotes else "")
                                       + POWERSHELL_QUOTED, re.S) for quotes in ("'\"", "'", "\"", "")}
# Where any part of the PowerShell scan can start.
POWERSHELL_QUOTE_START = re.compile(r"[@<#`'\"]")
# Git Bash's path conversion is what mangles a dot-led rev path; other shells pass it as written.
GIT_BASH = os.name == "nt"
# A `jq` call: a word of its own, not the `--jq` option of `gh`.
JQ = re.compile(r"(?:^|(?<=[\s;&|(]))jq(?:\.exe)?(?=\s|$)")

WRITE_THE_FILE = "its backslashes get eaten. Write the script with the Write tool, then run the file."


def blanked(match):
    """The matched text as spaces, line ends kept, so the positions around it stay put."""
    return re.sub(r"[^\n]", " ", match.group())


def as_quote(match):
    """A quoted string as its opening quote and spaces, a comment or an escape as spaces, line
    ends kept, so the text keeps its length, a call's position in it matches the original's, and
    the quote a script starts with stays where it is, whatever follows it."""
    spaces = blanked(match)
    if match.group()[:1] in "'\"":
        return match.group()[0] + spaces[1:]
    return spaces


def without_arithmetic(text):
    """The text with each `((...))` and `$((...))` blanked, where a `<<` opens nothing: an opener
    closes at the first `)` after it when a second `)` follows. That `)` is found once and kept for
    every opener before it, since searching from each opener takes time that grows with the square
    of a long run of `(`."""
    parts, at, look, close = [], 0, 0, -1
    while True:
        opener = text.find("((", look)
        if opener == -1:
            break
        if close < opener + 2:
            close = text.find(")", opener + 2)
            if close == -1:
                break
        start = opener - 1 if opener > at and text[opener - 1] == "$" else opener
        if text.startswith(")", close + 1):
            parts += [text[at:start], re.sub(r"[^\n]", " ", text[start:close + 2])]
            at = look = close + 2
        else:
            look = opener + 1
    return "".join(parts) + text[at:]


def as_word(match):
    """A quoted string as one placeholder word the length of the original, line ends kept, so a
    quoted argument (`python3 "$HOOK"`) still counts as a word."""
    return re.sub(r"^[^\n]", "Q", blanked(match))


def first_opener(text):
    """(line number, match) of the first line that may open a here-document, quoted or not, or
    None: a `<<` that is not part of a here-string (`<<<`) followed by a word."""
    for number, line in enumerate(text.split("\n")):
        for operator in HEREDOC_OPERATOR.finditer(line):
            match = HEREDOC.match(line, operator.start())
            if match:
                return number, match
    return None


def heredoc(text):
    """(receivers, body) of a bash command's first here-document, or None when it has none or its
    `<<` stands inside quotes, a comment or arithmetic, where the reading is unsure
    (`"$(cat <<'EOF'`). The receivers are the commands of its pipeline from the one the `<<` feeds
    on (`cat <<EOF | python3`), with quoted strings blanked."""
    first = first_opener(text)
    if not first:
        return None
    number, match = first
    masked = without_arithmetic(QUOTED["bash"].sub(as_word, text)).split("\n")[number]
    if not HEREDOC_OPERATOR.match(masked, match.start()):
        return None
    before = LIST_SEPARATOR.split(masked[:match.start()])[-1].split("|")[-1]
    after = LIST_SEPARATOR.split(masked[match.end():])[0].split("|")
    body = []
    for line in text.split("\n")[number + 1:]:
        if ends_heredoc(line, match):
            break
        body.append(line)
    return [before + after[0]] + after[1:], "\n".join(body)


def ends_heredoc(line, match):
    """Whether a line is the terminator of the here-document `match` opened."""
    line = line.rstrip("\r")
    return (line.lstrip("\t") if match.group(1) else line) == match.group(3)


def program_words(command):
    """A command's words without the `NAME=value` assignments before or among them."""
    return [word for word in command.split() if not re.fullmatch(r"\w+=\S*", word)]


def interpreter_name(word):
    """`python3.exe` and `/usr/bin/python3` as `python`: the key the option tables use."""
    return re.sub(r"\d+$", "", re.sub(r"(?i)\.exe$", "", re.split(r"[/\\]", word)[-1]).lower())


def gives_script(word, name):
    """Whether an option hands the interpreter its script itself (`-c`, `-ne`, `--eval=...`)."""
    if word.startswith("--"):
        return word.split("=", 1)[0].lower() in SCRIPT_LONG
    if name in ("pwsh", "powershell"):
        return word.lower() in POWERSHELL_SCRIPT
    return any(letter in word[1:] for letter in SCRIPT_LETTERS.get(name, ""))


def reads_script(command):
    """Whether this command is an interpreter that reads its script from standard input: nothing
    but options after it (`python`, `node`), `-`, or `-s` for a shell. A script file, a module or
    an inline script (`python3 x.py`, `python -m pkg`, `perl -ne '...'`) reads standard input as
    data, and so does an option whose value is unknown (`python -W x`); a script option given `-`
    (`pwsh -Command -`) reads it from standard input after all."""
    words = program_words(command)
    if not words or not PROGRAM.fullmatch(words[0]):
        return False
    name = interpreter_name(words[0])
    rest, k = words[1:], 0
    while k < len(rest):
        word = rest[k]
        if REDIRECTION.match(word):
            k += 2 if REDIRECTION.fullmatch(word) else 1  # a bare `>` names its target next
            continue
        if word == "-":
            return True
        if not word.startswith("-"):
            return False
        if gives_script(word, name):
            return rest[k + 1:k + 2] == ["-"]
        if name in SHELLS and re.fullmatch(r"-[a-z]*s[a-z]*", word):
            return True
        k += 1
    return True


def first_interpreter_reads(commands):
    """Whether the first interpreter among a pipeline's commands reads its script from standard
    input. Commands before it (`cat`, `sed`) pass the text on; once an interpreter has read it,
    later ones get only its output (`python3 gen.py <<EOF | sh`)."""
    for command in commands:
        words = program_words(command)
        if words and PROGRAM.fullmatch(words[0]):
            return reads_script(command)
    return False


def piped_to(rest_of_line):
    """The commands a PowerShell here-string is piped into: the pipeline after its closing line."""
    return re.split(r";|&&|\|\|", rest_of_line)[0].split("|")[1:]


def inline_script(text, shell):
    """Whether an interpreter is handed a script holding a backslash."""
    found = heredoc(text) if shell == "bash" else None
    if found and "\\" in found[1] and first_interpreter_reads(found[0]):
        return True
    if shell == "powershell" and any("\\" in (here.group(2) or "")
                                     and first_interpreter_reads(piped_to(here.group(3)))
                                     for here in here_strings(text)):
        return True
    # A `python -c '...'` a message only mentions leaves no call where its quotes are taken out.
    masked, end = masked_calls(text, shell)
    return any("\\" in (m.group(2) or m.group(4) or "") and m.start() < end and INLINE_CALL.match(masked, m.start())
               for m in INLINE.finditer(text))


def here_strings(text):
    """The PowerShell here-strings that stand outside quotes and comments, with the rest of the
    line each one ends on: the quote scan meets them before anything that would hold them."""
    return [HERE_STRING.match(text, m.start()) for m in quoted(text, "powershell") if m.group().startswith("@")]


def quoted(text, shell):
    """The quoted strings, comments and escapes the shell's scan finds, in order. A PowerShell
    here-string opener is tried only while a line that may close it follows."""
    if shell == "bash":
        return list(QUOTED["bash"].finditer(text))
    closes = {quote: text.rfind("\n" + quote + "@") for quote in "'\""}
    found, at = [], 0
    while True:
        start = POWERSHELL_QUOTE_START.search(text, at)
        if not start:
            return found
        quotes = "".join(quote for quote in "'\"" if closes[quote] > start.start())
        match = POWERSHELL_SCANS[quotes].match(text, start.start())
        if match:
            found.append(match)
        at = match.end() if match else start.start() + 1


def masked(text, shell, replace):
    """The command with each match of the shell's scan replaced by `replace`, a text or a
    function of the match, as `re.sub` takes it."""
    parts, at = [], 0
    for match in quoted(text, shell):
        parts += [text[at:match.start()], replace(match) if callable(replace) else replace]
        at = match.end()
    return "".join(parts + [text[at:]])


def masked_calls(text, shell):
    """(the command with quoted strings, comments and PowerShell here-strings masked to the same
    length, where a call may stand): a bash command only up to the end of the first line that may
    open a here-document, as in `bare`."""
    end = len(text)
    if shell == "bash":
        first = first_opener(text)
        if first:
            end = len("\n".join(text.split("\n")[:first[0] + 1]))
    return masked(text, shell, as_quote), end


def bare(text, shell):
    """The command with quoted strings taken out, and PowerShell here-string bodies; a bash
    command only up to the end of the first line that may open a here-document, quoted or not
    (`"$(cat <<'EOF'`), since reading too little only misses a pattern."""
    if shell == "bash":
        first = first_opener(text)
        if first:
            text = "\n".join(text.split("\n")[:first[0] + 1])
    return masked(text, shell, "''")


class Followed:
    """A search for `head`, then any characters but `stops`, then `rest`: the same answer as one
    pattern joining them, in time linear in the text. Every head whose run ends at the same stop
    finds `rest` only where the head ending first does, so `rest` is tried once per stop, where
    the joined pattern tries it once per head and a line repeating the head takes time that grows
    with its length squared. `skip_line` names text whose line a head may not start on."""

    def __init__(self, head, stops, rest, flags=re.I, skip_line=()):
        self.head = re.compile(head, flags)
        self.stop = re.compile("[%s]" % stops)
        self.tail = re.compile("[^%s]*%s" % (stops, rest), flags)
        self.skip_line = skip_line

    def skips(self, text, newlines, line):
        begin = newlines[line - 1] + 1 if line else 0
        end = newlines[line] if line < len(newlines) else len(text)
        return any(word in text[begin:end] for word in self.skip_line)

    def search(self, text):
        stops = [match.start() for match in self.stop.finditer(text)]
        newlines = [match.start() for match in re.finditer("\n", text)] if self.skip_line else []
        skipped, tried = {}, set()
        for head in self.head.finditer(text):
            run_end = bisect.bisect_left(stops, head.end())
            if run_end in tried:
                continue
            if self.skip_line:
                line = bisect.bisect_left(newlines, head.start())
                if line not in skipped:
                    skipped[line] = self.skips(text, newlines, line)
                if skipped[line]:
                    continue
            tried.add(run_end)
            if self.tail.match(text, head.end()):
                return True
        return False


def both(*patterns):
    """A test that holds when every pattern (a regex, or a `Followed`) is found in the bare command."""
    compiled = [p if isinstance(p, Followed) else re.compile(p, re.I) for p in patterns]
    return lambda text, shell: all(p.search(bare(text, shell)) for p in compiled)


def cased(pattern):
    """Like `both`, for one test whose letter case carries meaning (`-b` is not `-B`)."""
    compiled = pattern if isinstance(pattern, Followed) else re.compile(pattern)
    return lambda text, shell: bool(compiled.search(bare(text, shell)))


# Where the hook runs: the session's folder, from the hook's input; "." until it says.
CWD = "."
# The commit format's subject limit, and the PR title limit where PRs squash-merge: GitHub adds ` (#123)`.
SUBJECT_LIMIT = 72
TITLE_LIMIT = 64
COMMAND_END = re.compile(r"[\n;&|]")
# The length rules read Bash commands only: how PowerShell hands words to git or gh changes with its
# version and settings, so no splitter outside PowerShell matches it. What Bash would change, an expansion
# or an escape, leaves the command unread too.
UNPLAIN = re.compile(r"[$`\\]")
# The only characters a command may hold outside quotes and comments to be read. Any other (a glob, a
# tilde, a bracket, a redirection) can make Bash pass other words than shlex finds.
PLAIN_OUTSIDE = re.compile(r"[\w \t./:=+,%@-]*")
LONGEST_COMMAND = 10000  # a plain commit or PR command is shorter; a longer one is left unread


def commands(text, shell):
    """Each command's text and its shape, cut at a separator outside quotes and comments. The shape is
    the text with every character the shell's scan finds inside quotes or a comment, a line break
    included, written as `x`, so only a separator the shell reads can cut it."""
    _, end = masked_calls(text, shell)
    shape = list(text[:end])
    for found in quoted(text[:end], shell):
        shape[found.start():found.end()] = "x" * (found.end() - found.start())
    shape = "".join(shape)
    start = 0
    for found in COMMAND_END.finditer(shape):
        yield text[start:found.start()], shape[start:found.start()]
        start = found.end()
    yield text[start:end], shape[start:]


def plain_words(command, shape):
    """The Bash command's words as Bash passes them, or None when Bash would change any of them."""
    command = command.strip()
    if not command.startswith(("git", "gh")) or len(command) > LONGEST_COMMAND or UNPLAIN.search(command):
        return None
    if not PLAIN_OUTSIDE.fullmatch(shape.strip(" \t\r")):
        return None
    try:
        return shlex.split(command, comments=True)
    except ValueError:  # a quote that never closes
        return None


def git_commit_args(words):
    """The arguments after `commit` in `git [options] commit ...`; `-c` and `-C` take the next word."""
    if words[0] != "git":
        return None
    index = 1
    while index < len(words) and words[index].startswith("-"):
        index += 2 if words[index] in ("-c", "-C") else 1
    return words[index + 1:] if index < len(words) and words[index] == "commit" else None


def gh_pr_args(words):
    return words[3:] if words[:2] == ["gh", "pr"] and words[2:3] in (["create"], ["edit"]) else None


# A length rule, read the way the command's own option parser reads it:
# - args_of: the command's arguments, or None for another command;
# - letter and name: its message option, short and long;
# - value_letters: short options that take a value, the rest of their word or else the next word;
# - attached_only: short options that take one only attached (git's `-S<keyid>`);
# - value_names: long options that take the next word as their value whatever it starts with;
# - attached_equals: whether an attached value drops a leading `=` (gh's flag parser does; git's keeps it);
# - last_wins: whether the option given twice keeps its last value (gh's title) or its first (git's
#   subject, since each `-m` adds a paragraph).
LengthRule = collections.namedtuple(
    "LengthRule", "args_of letter name value_letters attached_only value_names attached_equals last_wins")


def short_options(arg, rule):
    """For a cluster of short options: the message letter's attached value ("" when it takes the next
    word) or None, and whether the cluster ends in an option that takes the next word."""
    for at, short in enumerate(arg[1:], 2):
        if short == rule.letter:
            # gh's flag parser drops the `=` of `-t=x`, but a bare `-t=` has `=` as its value.
            equals = rule.attached_equals and arg[at:at + 1] == "=" and len(arg) > at + 1
            attached = arg[at + 1:] if equals else arg[at:]
            return attached, not attached
        if short in rule.value_letters or short in rule.attached_only or not short.isalpha():
            return None, short in rule.value_letters and at == len(arg)
    return None, False


def message_values(args, rule):
    """Each value the message option is given, in order, skipping every other option's value."""
    index = 0
    while index < len(args):
        arg = args[index]
        following = args[index + 1] if index + 1 < len(args) else None
        index += 1
        if arg == "--":
            return
        if arg == rule.name:
            yield following
            index += 1
        elif arg.startswith(rule.name + "="):
            yield arg[len(rule.name) + 1:]
        elif arg in rule.value_names:
            index += 1
        elif len(arg) > 1 and arg[0] == "-" and arg[1].isalpha():
            attached, takes_next = short_options(arg, rule)
            if attached is not None:
                yield attached or following
            index += 1 if takes_next else 0


def message_value(args, rule):
    """The value git or gh keeps for the message option, or None."""
    values = list(message_values(args, rule))
    return (values[-1] if rule.last_wins else values[0]) if values else None


COMMIT_MESSAGE = LengthRule(
    git_commit_args, "m", "--message", "cCFt", "Su",
    {"--author", "--date", "--trailer", "--file", "--template", "--fixup", "--squash", "--cleanup",
     "--reuse-message", "--reedit-message", "--pathspec-from-file"}, False, False)
PR_TITLE = LengthRule(
    gh_pr_args, "t", "--title", "aBbFHlmpRrT", "",
    {"--body", "--body-file", "--base", "--head", "--label", "--assignee", "--reviewer", "--milestone",
     "--project", "--repo", "--template", "--recover", "--add-assignee", "--remove-assignee", "--add-label",
     "--remove-label", "--add-reviewer", "--remove-reviewer", "--add-project", "--remove-project"}, True, True)


def option_values(text, shell, rule):
    if shell != "bash":
        return
    for command, shape in commands(text, shell):
        words = plain_words(command, shape)
        args = rule.args_of(words) if words else None
        value = message_value(args, rule) if args is not None else None
        if value is not None:
            yield value


def first_line(message):
    return message.split("\n", 1)[0].strip()


def squash_merges():
    """Whether the repo the hook runs in squash-merges its PRs, by the answers Bindwright's setup saved."""
    try:
        folder = os.path.abspath(CWD)
    except OSError:  # a "." whose folder was deleted
        return False
    while True:
        try:
            with open(os.path.join(folder, ".bindwright", "project.json"), encoding="utf-8") as answers:
                return json.load(answers).get("advanced", {}).get("mergeStyle") == "squash"
        # RecursionError: JSON nested deeper than the reader goes.
        except (OSError, ValueError, AttributeError, RecursionError):
            pass
        parent = os.path.dirname(folder)
        if parent == folder or os.path.exists(os.path.join(folder, ".git")):
            return False
        folder = parent


def long_subject(text, shell):
    messages = option_values(text, shell, COMMIT_MESSAGE)
    return any(len(first_line(message)) > SUBJECT_LIMIT for message in messages)


def long_title(text, shell):
    titles = option_values(text, shell, PR_TITLE)
    return any(len(first_line(title)) > TITLE_LIMIT for title in titles) and squash_merges()


# `origin/develop:.claude/x`: a git object path that starts with a dot.
REV_DOT_PATH = Followed(r"\bgit\s+(?:show|cat-file|ls-tree|diff)\b", r"\n|;&", r"\s[\w./@~^-]+:\.[^/\s.]")

ENFORCE = "enforce"
OBSERVE = "observe"
OBSERVED_LOG = os.path.join(os.path.expanduser("~"), ".bindwright", "tool-rules", "observed.jsonl")
# Past this many bytes the log moves to a single `.old` copy and starts over, so it never grows unbounded.
OBSERVED_LOG_LIMIT = 256 * 1024
# A run of 24 or more letters, digits and _-+/= holding a digit reads as a token or key (base64 included):
# the log keeps a placeholder. The digit is checked on each run found, since a lookahead for it
# makes a long run take time that grows with its length squared.
TOKEN_RUN = re.compile(r"[A-Za-z0-9_\-+/=]{24,}")


def without_tokens(text):
    return TOKEN_RUN.sub(lambda run: "<token>" if re.search(r"\d", run.group()) else run.group(), text)

RULES = [
    ("an inline script holding a backslash", inline_script, WRITE_THE_FILE, ENFORCE),
    ("`gh run watch`", both(r"\bgh\s+run\s+watch\b"),
     "it blocks the session. ci-watch (or a bounded watcher, token-efficiency.md) watches checks.", ENFORCE),
    ("the size check chained with a commit or push",
     both(r"(?:^|(?<=[\s;&|(]))(?:python3?|py)(?:\.exe)?\s+(?:-\S+\s+)*\S*size_check\.py",
          r"\bgit\s+(?:commit|push)\b"),
     "the commit runs past its breaches. Run size_check.py in its own call first.", ENFORCE),
    ("`git push` and `gh pr create` in one command", both(r"\bgit\s+push\b", r"\bgh\s+pr\s+create\b"),
     "the chain gets refused. Push, then open the PR in a separate call.", ENFORCE),
    ("`git checkout <rev> -- <path>`", both(r"\bgit\s+checkout\s+(?!-)\S+\s+--\s+\S"),
     "it overwrites and stages those files. Peek with `git show <rev>:./<path>`; restore with `git restore`.",
     ENFORCE),
    ("`gh pr merge --admin`", both(Followed(r"\bgh\s+pr\s+merge\b", r"\n", r"\s--admin\b")),
     "it skips the required checks. Fix what blocks the merge.", ENFORCE),
    ("a repo secret write (`gh secret set` or `delete`)",
     both(r"\bgh\s+secret\s+(?:set|delete|remove)\b"),
     "secrets are the maintainer's, and a test run can overwrite the real ones. Give the user the command.",
     ENFORCE),
    ("`<rev>:.<path>` in Git Bash",
     lambda text, shell: GIT_BASH and shell == "bash" and REV_DOT_PATH.search(bare(text, shell)),
     "Git Bash rewrites it, so the file looks missing. Write `<rev>:./<path>` from the repo root.", ENFORCE),
    ("`gh run rerun --failed` or `--job`",
     both(Followed(r"\bgh\s+run\s+rerun\b", r"\n|;&", r"\s(?:--failed|--job|-j)\b")),
     "a re-run of only some jobs can leave a required check stuck. Re-run the whole run, or push again.", OBSERVE),
    ("an interactive git command (`-i`, `-p`)",
     # `git stash show -p` only prints, and a rebase given a scripted editor never waits for keys.
     cased(Followed(r"\bgit\s+(?:rebase|add|checkout|reset|stash(?!\s+(?:show|list)\b)|restore|clean)\b",
                    r"\n|;&", r"\s(?:-i|--interactive|-p|--patch)\b", flags=0,
                    skip_line=("GIT_SEQUENCE_EDITOR=", "sequence.editor="))),
     "it waits for an editor or keys a tool call cannot give. Use the form that takes its input in the command.",
     OBSERVE),
    ("an inline body for `gh pr` or `gh issue`",
     cased(Followed(r"\bgh\s+(?:pr|issue)\s+(?:create|comment|edit|review)\b", r"\n|;&",
                    r"\s(?:--body|-b)(?:[=\s]|$)", flags=0)),
     "the shell can cut or change the text. Write the body to a file and pass `--body-file`.", OBSERVE),
    ("a scratch file in a fixed folder (`/tmp`, `C:/tmp`)",
     # Claude Code's own session scratchpad lives under /tmp/claude-<id>/ on Linux.
     both(r"(?:^|(?<=[\s=>]))(?:/tmp|[a-z]:[\\/]tmp)(?![\w.-]|/claude-\d+/)"),
     "other sessions share it, and nothing cleans it up. Use the session's scratchpad instead.", OBSERVE),
    ("`jq` in Git Bash", lambda text, shell: GIT_BASH and shell == "bash" and JQ.search(bare(text, shell)),
     "Git Bash has no `jq`. Filter with the `--jq` option of `gh`, or with Python.", OBSERVE),
    ("a commit subject over 72 characters", long_subject,
     "the commit format caps the first line at 72. Shorten it, and put the detail in the body.", OBSERVE),
    ("a PR title over 64 characters where PRs squash-merge", long_title,
     "the title becomes the commit subject, and GitHub adds ` (#123)` to it. Shorten it to 64.", OBSERVE),
    # `git checkout -- <file>` restores files and switches nothing.
    ("a branch switch chained with other commands",
     both(r"\bgit\s+(?:checkout|switch)\b(?!\s+--(?:\s|$))", r"&&|\|\||;|\n\s*\S"),
     "a refused or failed chain can skip the switch, so the next edit lands on the wrong branch. Switch in a"
     " call of its own, check `git branch --show-current`, then go on.", OBSERVE),
]


def observe(name, text, shell):
    """Append one would-be refusal to OBSERVED_LOG; a log that cannot be written is skipped."""
    entry = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "rule": name, "shell": shell,
             "command": without_tokens(text)[:500]}
    try:
        os.makedirs(os.path.dirname(OBSERVED_LOG), exist_ok=True)
        if os.path.exists(OBSERVED_LOG) and os.path.getsize(OBSERVED_LOG) > OBSERVED_LOG_LIMIT:
            os.replace(OBSERVED_LOG, OBSERVED_LOG + ".old")
        with open(OBSERVED_LOG, "a", encoding="utf-8") as log:
            log.write(json.dumps(entry) + "\n")
    except OSError:
        pass


def refusal(text, shell):
    """The first enforce rule the command breaks, as (name, why), or None.

    Observe rules it breaks before that one are logged."""
    for name, test, why, mode in RULES:
        if not test(text, shell):
            continue
        if mode == ENFORCE:
            return name, why
        observe(name, text, shell)
    return None


def deny(name, why):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse", "permissionDecision": "deny",
        "permissionDecisionReason": f"BLOCKED (tool rule): {name}: {why}",
    }}))
    sys.exit(0)


def main():
    try:
        data = json.loads(sys.stdin.buffer.read().decode("utf-8-sig"))
        text = data["tool_input"]["command"]
    except Exception:
        sys.exit(0)
    if not isinstance(text, str):
        sys.exit(0)
    shell = "powershell" if data.get("tool_name") == "PowerShell" else "bash"
    global CWD
    cwd = data.get("cwd")
    CWD = cwd if isinstance(cwd, str) and cwd else CWD
    refused = refusal(text, shell)
    if refused:
        deny(*refused)
    sys.exit(0)


if __name__ == "__main__":
    main()
