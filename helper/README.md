# Bindwright helper

The files the [Bindwright](https://starfoxcom.github.io/bindwright/) Claude Code plugin runs on your computer: the setup engine (Node and Python twins), the templates it writes, the extras it can add to your config folder, and its small scripts (anonymous review counts, layout check, session notice, runner check).

You do not install this by hand. `/bindwright:setup` offers to install it, at the exact version the plugin names, into `~/.bindwright/helper`, with no admin rights and no global install, and `/bindwright:update` keeps it at the plugin's version. It has no dependencies and no install scripts.

- Source and issues: https://github.com/starfoxcom/bindwright
- Each version is built from the release tag of that repository and published by its release workflow.
- License: MIT
