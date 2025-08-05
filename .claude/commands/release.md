---
description: Create a new release for the Letta Obsidian plugin
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Bash(gh:*)
model: sonnet
---

Create a new release for the Letta Obsidian plugin:

1. Bump version numbers in manifest.json, package.json, and versions.json
2. Build the production plugin with `node esbuild.config.mjs production` 
3. Commit and push the changes
4. Create a GitHub release with the built files (main.js, manifest.json, styles.css)

Use semantic versioning (patch for bug fixes, minor for features, major for breaking changes).

$ARGUMENTS