#!/usr/bin/env python3
import re

# Read the main.ts file
with open('main.ts', 'r') as f:
    content = f.read()

# Remove sourceName from settings interface and defaults
content = re.sub(r'\tsourceName: string;\n', '', content)
content = re.sub(r'\tsourceName: "obsidian-vault-files",\n', '', content)

# Remove source and syncingFiles variables
content = re.sub(r'\tsource: LettaSource \| null = null;\n', '', content)
content = re.sub(r'\tprivate syncingFiles: Set<string> = new Set\(\);\n', '', content)

# Remove setupSource call
content = re.sub(r'\t+await this\.setupSource\(\);\n', '', content)

# Remove all references to this.source
content = re.sub(r' && this\.source', '', content)
content = re.sub(r'this\.source = null;?\n?', '', content)
content = re.sub(r'this\.syncingFiles\.clear\(\);?\n?', '', content)

# Remove the entire setupSource function
content = re.sub(r'\n\tasync setupSource\(\): Promise<void> \{[\s\S]*?\n\t\}\n(?=\n\tasync)', '\n', content)

# Remove file sync functions
functions_to_remove = [
    'syncVaultToLetta',
    'syncCurrentFile',
    'onFileChange',
    'onFileDelete',
    'openFileInAgent',
    'closeFileInAgent',
    'closeAllFilesInAgent'
]

for func in functions_to_remove:
    # Remove async function definitions and their entire body
    pattern = rf'\n\tasync {func}\([^)]*\): Promise<[^>]+> \{{[\s\S]*?\n\t\}}\n'
    content = re.sub(pattern, '\n', content)

# Remove upload queue and rate limiting code
content = re.sub(r'\n\t// Rate limiter for file uploads.*?\n\tprivate uploadQueue:.*?\n', '\n', content)
content = re.sub(r'\tprivate uploadQueue: Array<\(\) => Promise<void>> = \[\];\n', '', content)
content = re.sub(r'\tprivate uploadsInLastMinute: number\[\] = \[\];\n', '', content)
content = re.sub(r'\tprivate isProcessingQueue: boolean = false;\n', '', content)

# Remove addToUploadQueue and processUploadQueue functions
content = re.sub(r'\n\tprivate async addToUploadQueue\([\s\S]*?\n\t\}\n(?=\n)', '\n', content)
content = re.sub(r'\n\tprivate async processUploadQueue\(\): Promise<void> \{[\s\S]*?\n\t\}\n', '\n', content)

# Remove folder attachment logic from setupAgent
content = re.sub(r'\t+// Check if folder is already attached.*?\n', '', content)
content = re.sub(r'\t+// Checking if folder is attached.*?\n', '', content)
content = re.sub(r'\t+const agentFolders = existingAgent\.sources.*?\n', '', content)
content = re.sub(r'\t+const folderAttached = agentFolders\.some[\s\S]*?\);\n', '', content)
content = re.sub(r'\t+if \(!folderAttached\) \{[\s\S]*?\t+\} else \{[\s\S]*?\t+\}\n', '', content)

# Remove file watcher registrations
content = re.sub(r'\t+// Watch for file changes[\s\S]*?this\.onFileDelete\(file\);\s*\}\s*\}\),\s*\);\n', '', content)

# Remove context menu for syncing files
content = re.sub(r'\t+// Add context menu for syncing files[\s\S]*?this\.syncCurrentFile\(file\);\s*\}\);\s*\}\);\s*\}\s*\}\),\s*\);\n', '', content)

# Remove sync current file command
content = re.sub(r'\t+this\.addCommand\(\{\s*id: "sync-current-file-to-letta",[\s\S]*?\}\);\n', '', content)

# Remove source check from setupAgent
content = re.sub(r'\t+if \(!this\.source\) throw new Error\("Source not set up"\);\n', '', content)

# Remove FolderCreationConsentModal and FolderAttachmentConsentModal classes
content = re.sub(r'\nclass FolderCreationConsentModal extends Modal \{[\s\S]*?\n\}\n', '\n', content)
content = re.sub(r'\nclass FolderAttachmentConsentModal extends Modal \{[\s\S]*?\n\}\n', '\n', content)

# Remove askBeforeFolderCreation and askBeforeFolderAttachment settings
content = re.sub(r'\taskBeforeFolderCreation: boolean;.*?\n', '', content)
content = re.sub(r'\taskBeforeFolderAttachment: boolean;.*?\n', '', content)
content = re.sub(r'\taskBeforeFolderCreation: true,.*?\n', '', content)
content = re.sub(r'\taskBeforeFolderAttachment: true,.*?\n', '', content)

# Write the cleaned content back
with open('main.ts', 'w') as f:
    f.write(content)

print("Filesystem code removed successfully!")