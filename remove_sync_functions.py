#!/usr/bin/env python3
import re

# Read the main.ts file
with open('main.ts', 'r') as f:
    lines = f.readlines()

# Track which lines to keep
keep_lines = [True] * len(lines)

# Find and mark sync functions for removal
functions_to_remove = [
    'syncVaultToLetta',
    'syncCurrentFile',
    'onFileChange',
    'onFileDelete',
    'openFileInAgent',
    'closeFileInAgent',
    'closeAllFilesInAgent'
]

for func_name in functions_to_remove:
    in_function = False
    brace_count = 0
    func_start = -1

    for i, line in enumerate(lines):
        # Check if this is the start of the function
        if f'\tasync {func_name}(' in line:
            in_function = True
            func_start = i
            brace_count = 0
            keep_lines[i] = False
            continue

        if in_function:
            keep_lines[i] = False
            # Count braces
            brace_count += line.count('{')
            brace_count -= line.count('}')

            # Check if function ended
            if brace_count == 0 and '\t}' in line:
                in_function = False

# Write back only the lines we want to keep
with open('main.ts', 'w') as f:
    for i, line in enumerate(lines):
        if keep_lines[i]:
            f.write(line)

print("Sync functions removed!")