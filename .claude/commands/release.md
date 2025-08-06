---
description: Create a new release for the Letta Obsidian plugin
allowed-tools: Bash(git:*), Bash(npm:*), Bash(node:*), Bash(gh:*)
model: sonnet
---

Create a new release for the Letta Obsidian plugin following Obsidian's official guidelines:

## Process Overview
1. **Verify current state**: Check existing version files and git tags
2. **Update version files**: Bump version numbers in manifest.json, package.json, and versions.json (if needed)
3. **Build production**: Run `node esbuild.config.mjs production` to create optimized build
4. **Create annotated tag**: Use `git tag -a X.Y.Z -m "X.Y.Z"` (NO "v" prefix)
5. **Push tag**: Use `git push origin X.Y.Z` to trigger GitHub Actions
6. **Verify release**: Check that draft release was created with all required files

## Important Requirements (Per Obsidian Guidelines)
- **Tag format**: Use exact version number WITHOUT "v" prefix (e.g., "1.3.0" not "v1.3.0")
- **Annotated tags**: Always use `git tag -a` with message matching version number
- **Required files**: Release must contain main.js, manifest.json, styles.css as individual files
- **Draft releases**: Workflow creates draft releases for manual review and publishing
- **Version matching**: GitHub release name must exactly match manifest.json version

## GitHub Actions Workflow
- Triggers automatically on tag push (`tags: ["*"]`)
- Builds plugin with `npm install && npm run build`
- Creates draft release with required files attached
- Uses `--draft` flag for manual review before publishing

## After Release Creation
1. Visit GitHub releases page
2. Edit the draft release to add release notes
3. Describe changes/features in this version
4. Publish release when ready

## Version Guidelines
- Use semantic versioning: MAJOR.MINOR.PATCH
- Patch: Bug fixes (1.3.0 → 1.3.1)
- Minor: New features (1.3.0 → 1.4.0)  
- Major: Breaking changes (1.3.0 → 2.0.0)

$ARGUMENTS