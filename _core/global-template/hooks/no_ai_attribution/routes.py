"""The attribution guard's hook routes: commands that skip or change the hooks git runs."""
import itertools
import re
from .shell import WRAPPERS, program, shape_of, text_of
from .files import (ENV_VALUE_OPTIONS, ENV_VALUE_SHORT, abbreviates, git_subcommand,
    is_run_time_git, is_uncertain, takes_next_word)


LEFTHOOK_OFF_VALUES = {"0", "false"}
# git's own subcommands (`git help -a`). After a word built at run time in the subcommand place,
# only one of these names a subcommand; any other literal word may be an option's value (`-m x`).
GIT_SUBCOMMANDS = {
    "add", "am", "annotate", "apply", "archive", "bisect", "blame", "branch", "bundle", "cat-file",
    "check-attr", "check-ignore", "checkout", "cherry", "cherry-pick", "citool", "clean", "clone",
    "commit", "commit-graph", "commit-tree", "config", "count-objects", "describe", "diff",
    "diff-files", "diff-index", "diff-tree", "difftool", "fetch", "for-each-ref", "format-patch",
    "fsck", "gc", "grep", "hash-object", "help", "init", "log", "ls-files", "ls-remote", "ls-tree",
    "maintenance", "merge", "merge-base", "mergetool", "mv", "name-rev", "notes", "prune", "pull",
    "push", "range-diff", "rebase", "reflog", "remote", "repack", "replace", "reset", "restore",
    "rev-list", "rev-parse", "revert", "rm", "shortlog", "show", "show-ref", "sparse-checkout",
    "stash", "status", "submodule", "switch", "symbolic-ref", "tag", "update-index", "update-ref",
    "var", "verify-commit", "verify-tag", "version", "whatchanged", "worktree", "write-tree",
}
# The options of each wrapper that take the next word as their value (`sudo -u root git`).
WRAPPER_VALUE_OPTIONS = {
    "sudo": {"-u", "-g", "-C", "-D", "-h", "-p", "-r", "-t", "-T", "-U", "--user", "--group",
             "--chdir", "--host", "--prompt", "--role", "--type", "--other-user", "--close-from",
             "--command-timeout"},
    "doas": {"-u", "-C"},
    "env": ENV_VALUE_SHORT | set(ENV_VALUE_OPTIONS),
    "nice": {"-n", "--adjustment"},
    "xargs": {"-a", "-d", "-E", "-I", "-L", "-n", "-P", "-s", "--arg-file", "--delimiter",
              "--max-args", "--max-procs", "--max-chars"},
}
# Each word built at run time doubles the readings of one git call; past this many, it is refused.
MAX_RUN_TIME_WORDS = 10
# Subcommands whose --no-verify skips a hook, and the options of each that take a value, so a
# value (`-m -n`) is never read as an option. A long option may be shortened to any unique
# prefix of at least the length given.
NO_VERIFY_SUBCOMMANDS = {"commit", "am", "merge", "push", "rebase"}
SHORT_VALUES = {"commit": "cCFmt", "am": "C", "merge": "mFsX", "push": "o", "rebase": "sXx"}
# Letters whose value is optional and only ever written onto them (`-uno`, `-S<keyid>`).
ATTACHED_VALUES = {"commit": "uS", "am": "S", "merge": "S", "rebase": "S"}
LONG_VALUES = {
    "commit": {"--author", "--date", "--file", "--message", "--reedit-message", "--reuse-message",
               "--fixup", "--squash", "--template", "--trailer", "--cleanup", "--pathspec-from-file"},
    "am": {"--directory", "--exclude", "--include", "--patch-format", "--resolvemsg", "--whitespace"},
    "merge": {"--strategy", "--strategy-option", "--message", "--file", "--into-name", "--cleanup"},
    "push": {"--push-option", "--repo", "--receive-pack", "--exec"},
    "rebase": {"--strategy", "--strategy-option", "--exec", "--onto"},
}
# `git config`'s options that take the next word as their value, each with the shortest prefix git
# 2.56 reads as it (an ambiguous prefix makes git refuse the command).
CONFIG_VALUE_OPTIONS = {"--file": "--fil", "--blob": "--bl", "--type": "--t", "--default": "--d",
                        "--comment": "--co", "--value": "--v"}
CONFIG_VALUE_SHORT = {"-f", "-t"}
CONFIG_READS = {"get", "list", "edit", "get-regexp", "get-all", "get-urlmatch", "get-color",
                "get-colorbool"}
CONFIG_WRITES = {"set", "unset", "remove-section", "rename-section"}


def option_words(subcommand, rest):
    """The options of one git subcommand, one per letter of a bundle (`-nm` is `-n`, `-m`), with
    every option's value skipped, up to `--`."""
    options, skip, letters = [], False, SHORT_VALUES.get(subcommand, "")
    for word in (text_of(w) for w in rest):
        if skip:
            skip = False
        elif word == "--":
            break
        elif word.startswith("--"):
            options.append(word.split("=", 1)[0])
            skip = "=" not in word and any(abbreviates(word, o, o[:5]) for o in LONG_VALUES.get(subcommand, ()))
        elif word.startswith("-") and len(word) > 1:
            for k, letter in enumerate(word[1:], 1):
                options.append("-" + letter)
                if letter in letters:
                    skip = k == len(word) - 1 and not is_uncertain(word)
                    break
                if letter in ATTACHED_VALUES.get(subcommand, ""):  # `-uno`: the rest is its value
                    break
    return options


def names_hooks(setting):
    setting = setting.lower()
    return "hookspath" in setting or setting.startswith("hook.")


def names_hook_section(section):
    """Whether removing or renaming this section drops hook settings (`core` holds hooksPath)."""
    section = section.lower()
    return section in ("hook", "core") or section.startswith("hook.")


def config_option_takes_value(word):
    """Whether a `git config` option reads the next word as its value."""
    return takes_next_word(word, CONFIG_VALUE_SHORT, CONFIG_VALUE_OPTIONS)


def config_words(rest):
    """(the names and values `git config` reads, its options), or None when it is a read."""
    names, options, skip, ended = [], [], False, False
    for raw in rest:
        word = text_of(raw)
        # The old form (`git config <name> <value>`) stops reading options at the first name, so a
        # later `--get` is the value it stores.
        legacy = names and names[0] not in CONFIG_WRITES and names[0] not in CONFIG_READS
        if skip:
            skip = False
        elif word == "--" and not ended and not legacy:
            # Git reads every word after `--` as a name or value, never as an option.
            ended = True
        elif word.startswith("-") and not legacy and not ended:
            if word.startswith("--get") or word in ("-l", "--list"):
                return None
            options.append(word)
            skip = config_option_takes_value(word)
        else:
            names.append(word)
    return names, options


def config_sets_hooks(rest):
    """Whether `git config` sets or unsets a hook setting, or removes or renames a section that
    holds them; a read passes."""
    read = config_words(rest)
    if read is None:
        return False
    names, options = read
    unsets = any(abbreviates(o, "--unset-all", "--uns") for o in options)
    sections = any(abbreviates(o, "--remove-section", "--rem") or abbreviates(o, "--rename-section", "--ren")
                   for o in options)
    if names[:1] in (["remove-section"], ["rename-section"]):
        sections, names = True, names[1:]
    if sections:
        return bool(names) and names_hook_section(names[0])
    if names[:1] in (["set"], ["unset"]):
        unsets, names = unsets or names[0] == "unset", names[1:]
    elif names[:1] and names[0] in CONFIG_READS:
        return False
    return len(names) >= (1 if unsets else 2) and names_hooks(names[0])


def git_route(words):
    """The kind of route past the hooks one git call takes, or None. A word built at run time is
    read as its literal text with a NUL for each part built at run time (`--trailer=$WHO`,
    `"$S.hooksPath"`), and each one the parser says can expand to nothing is also read as no
    word, apart from the others (`git $OPTS commit`)."""
    head, rest = words[:1], words[1:]
    run_time = [i for i, word in enumerate(rest) if not isinstance(word, str) and word["canBeEmpty"]]
    if len(run_time) > MAX_RUN_TIME_WORDS:
        return "unread"
    known = [shape_of(word) for word in rest]
    for empty in itertools.product((False, True), repeat=len(run_time)):
        dropped = {i for i, is_empty in zip(run_time, empty) if is_empty}
        reading = [word for i, word in enumerate(known) if i not in dropped]
        route = literal_git_route(head + reading)
        if route:
            return route
    return None


def built_subcommand(words):
    """Whether git's subcommand comes from a word built at run time with no git subcommand written
    after it (`git "${args[@]}"`, `git "$@" -m x`), so that word may hold any subcommand and its
    options. `git $OPTS commit` names its subcommand and is read as usual."""
    i = git_subcommand(words)[0]
    if i >= len(words) or isinstance(words[i], str):
        return False
    return not any(isinstance(word, str) and word in GIT_SUBCOMMANDS for word in words[i + 1:])


def runs_program_at(words, i):
    """Whether words[i] is the program a command runs: its first word, or the first after wrappers
    (`sudo -u root`, `env A=1`), their options with their values, and NAME=value words. A word only
    named as an argument (`grep git "$f"`, `cp "$src/.git" "$dst"`) is not."""
    j = 0
    while j < i and program(words[j:]) in WRAPPERS:
        takes_value = WRAPPER_VALUE_OPTIONS.get(program(words[j:]), set())
        j += 1
        while j < i and (shape_of(words[j]).startswith("-") or re.match(r"\w+=", shape_of(words[j]))):
            j += 2 if shape_of(words[j]) in takes_value else 1
    return j == i


def literal_git_route(words):
    """The route of a git call whose words after the program are all literal, or None."""
    i = git_subcommand(words)[0]
    before = words[1:i]
    settings = [v for k, v in zip(before, before[1:]) if k in ("-c", "--config-env")]
    settings += [w.split("=", 1)[1] for w in before if w.startswith("--config-env=")]
    if any(names_hooks(s) for s in settings):
        return "setting"
    if i >= len(words):
        return None
    subcommand, rest = words[i], words[i + 1:]
    if subcommand == "config":
        return "setting" if config_sets_hooks(rest) else None
    options = option_words(subcommand, rest)
    if subcommand in NO_VERIFY_SUBCOMMANDS and any(abbreviates(o, "--no-verify", "--no-v") for o in options):
        return "hooks"
    if subcommand in ("commit", "am") and "-n" in options:
        return "hooks"
    if subcommand != "commit":
        return None
    if any(abbreviates(o, "--trailer", "--tr") for o in options):
        return "trailer"
    reuses = ("--reuse-message", "--reedit-message")
    if any(o in ("-C", "-c") or any(abbreviates(o, r, r[:5]) for r in reuses) for o in options):
        return "reuse"
    return None


def env_assignments(words):
    """The `NAME=value` words an `env` in this command sets for the program it runs."""
    found = []
    for i in range(len(words)):
        if program(words[i:]) == "env":
            found += env_words(words[i + 1:])
    return found


def env_words(args):
    """The `NAME=value` words before `env`'s program. An option whose letters are built at run time
    (`-${Q}u`) may or may not take the next word, so every reading is followed at once: `states`
    holds, per reading still alive, whether the next word is an option's value."""
    found, states = [], {False}
    for word in args:
        shape, following = shape_of(word), set()
        for skip in states:
            if skip:
                following.add(False)
            elif shape.startswith("-"):
                following |= env_option_skips(shape)
            elif re.match(r"\w+=", shape):
                found.append(text_of(word))
                following.add(False)
        states = following
        if not states:
            break
    return found


def env_option_skips(word):
    """Whether an `env` option takes the next word, as the set of its possible answers."""
    unknown = next((i for i, sign in enumerate(word) if sign in "\0*?[{"), len(word))
    if unknown == len(word) or word.startswith("--") and "=" in word[:unknown]:
        return {takes_next_word(word, ENV_VALUE_SHORT, ENV_VALUE_OPTIONS)}
    return {False, True}


def turns_lefthook_off(commands, assignments):
    """Whether the command sets LEFTHOOK to 0 or false (by assignment, `export`, `env` or
    PowerShell's `$env:`), or to a value built at run time by any of them but `env`, or runs
    `lefthook uninstall`."""
    settings = [(s.get("name"), s.get("value")) for s in assignments if isinstance(s, dict)]
    settings += [tuple(text.split("=", 1)) for words in commands for text in env_assignments(words)]
    for name, value in settings:
        name = re.sub(r"^\$\{?(?:env:)?|\}$", "", str(name), flags=re.I).lower()
        if name == "lefthook" and (not isinstance(value, str) or value.strip("'\"").lower() in LEFTHOOK_OFF_VALUES):
            return True
    for words in commands:
        for i in range(len(words)):
            if program(words[i:]) == "lefthook":
                rest = [text_of(w) for w in words[i + 1:] if not text_of(w).startswith("-")]
                if rest[:1] == ["uninstall"]:
                    return True
    return False


def hook_route(groups, assignments):
    """The kind of route past git's hooks the commands of `with_nested`'s groups take, or None.
    A git run through a wrapper (`env A=1 git`, `sudo git`) counts, as does a word built at run
    time that names git (`$GIT`)."""
    commands = [words for group, _, _ in groups for words in group]
    if turns_lefthook_off(commands, assignments):
        return "lefthook"
    for words in commands:
        for i, word in enumerate(words):
            if program(words[i:]) == "git" or is_run_time_git(word):
                if runs_program_at(words, i) and built_subcommand(words[i:]):
                    return "built"
                route = git_route(words[i:])
                if route:
                    return route
    return None
