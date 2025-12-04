# Task 7: Fix Frontmatter Deletion Bug

## Objective
Fix the bug where platform-specific YAML files (`.cursor.yml`, `.claude.yml`, etc.) are randomly deleted and merged into the base markdown file during `save` and `install` operations with local registry.

## Current Bug Behavior
**What's happening:**
1. Package has files:
   - `rules/base.md` (platform-agnostic markdown)
   - `rules/base.cursor.yml` (Cursor-specific frontmatter)
   - `rules/base.claude.yml` (Claude-specific frontmatter)

2. After `save` or `install` with local registry:
   - ONE random platform `.yml` file gets deleted (e.g., `base.cursor.yml`)
   - That YAML content gets merged into `base.md` as frontmatter
   - `base.md` becomes platform-specific (corrupted)
   - Other `.yml` files remain intact

**Expected behavior:**
- Keep ALL platform `.yml` files separate
- Keep `base.md` platform-agnostic (no platform-specific frontmatter)
- Never delete platform YAML files
- Never merge platform YAML into base markdown

## Root Cause
**File:** `src/core/save/save-yml-resolution.ts`

**Function:** `applyOverrideFiles()` (lines 400-432)

The bug is in this logic:
```typescript
// Lines 420-423
if (finalFrontmatter === undefined) {
  if (await exists(overridePath)) {
    await remove(overridePath);  // ← BUG: Incorrectly deletes
  }
}
```

The code incorrectly determines that a platform YAML file has no content when it should be preserved.

## Implementation Steps

### 1. Add Validation Function
**File:** `src/core/save/save-yml-resolution.ts`

Add new function before `applyFrontmatterMergePlans`:

```typescript
/**
 * Validate frontmatter plans to prevent deletion of existing platform YAML files
 */
async function validateFrontmatterPlans(
  plans: FrontmatterMergePlan[],
  packageDir: string
): Promise<void> {
  for (const plan of plans) {
    for (const [platform, resolution] of plan.overrideDecisions.entries()) {
      const overridePath = join(
        packageDir,
        plan.registryPath.replace('.md', `.${platform}.yml`)
      );

      // If override file exists and resolution says to delete it, preserve it instead
      if (await exists(overridePath) && resolution.finalFrontmatter === undefined) {
        logger.warn(`Preventing deletion of platform YAML: ${overridePath}`);

        try {
          // Read existing frontmatter to preserve it
          const existingContent = await readFile(overridePath, 'utf-8');
          const existingYaml = yaml.load(existingContent);

          if (existingYaml && typeof existingYaml === 'object') {
            resolution.finalFrontmatter = existingYaml as Record<string, any>;
            logger.debug(`Preserved existing YAML for ${platform}: ${overridePath}`);
          }
        } catch (error) {
          logger.error(`Failed to read platform YAML ${overridePath}: ${error}`);
        }
      }
    }
  }
}
```

### 2. Call Validation Before Applying Plans
**File:** `src/core/save/save-conflict-resolution.ts` (line 265)

Update the frontmatter plan application:

```typescript
// BEFORE:
await applyFrontmatterMergePlans(candidateGroups, frontmatterPlans, cwd);

// AFTER:
// Validate plans before applying to prevent deletion
await validateFrontmatterPlans(frontmatterPlans, packageDir);

await applyFrontmatterMergePlans(candidateGroups, frontmatterPlans, cwd);
```

### 3. Fix Override Deletion Logic
**File:** `src/core/save/save-yml-resolution.ts` (lines 400-432)

Update `applyOverrideFiles` function:

```typescript
async function applyOverrideFiles(
  packageDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  for (const [platform, resolution] of plan.overrideDecisions.entries()) {
    const overridePath = join(
      packageDir,
      plan.registryPath.replace('.md', `.${platform}.yml`)
    );

    // UPDATED LOGIC:
    if (resolution.finalFrontmatter === undefined) {
      // ONLY delete if file was explicitly marked for deletion
      // AND we've confirmed it has no content
      // OTHERWISE, preserve existing file

      const fileExists = await exists(overridePath);

      if (fileExists) {
        // Double-check: is there actual content?
        try {
          const content = await readFile(overridePath, 'utf-8');
          const parsed = yaml.load(content);

          if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
            // File has content, DO NOT DELETE
            logger.debug(`Preserving non-empty platform YAML: ${overridePath}`);
            continue;
          }
        } catch (error) {
          logger.warn(`Could not parse ${overridePath}, preserving file: ${error}`);
          continue;
        }

        // Only delete if truly empty
        logger.debug(`Removing empty platform YAML: ${overridePath}`);
        await remove(overridePath);
      }
    } else {
      // Write override file
      const yamlContent = yaml.dump(resolution.finalFrontmatter, {
        indent: 2,
        lineWidth: -1,
        noRefs: true
      });

      await writeFile(overridePath, yamlContent, 'utf-8');
      logger.debug(`Wrote platform YAML: ${overridePath}`);
    }
  }
}
```

### 4. Ensure Platform YAML Discovery
**File:** `src/core/save/save-conflict-resolution.ts` (lines 269-315)

Update `loadLocalCandidates` to explicitly discover platform YAML files:

```typescript
async function loadLocalCandidates(packageDir: string): Promise<SaveCandidate[]> {
  const candidates: SaveCandidate[] = [];

  if (!(await exists(packageDir))) {
    return candidates;
  }

  // Find all files including .yml files
  const entries = await findFilesByExtension(packageDir, [], packageDir);

  for (const filePath of entries) {
    const registryPath = relative(packageDir, filePath);
    const content = await readFile(filePath, 'utf-8');

    // Check if it's a platform-specific YAML file
    const isPlatformYaml = /\.\w+\.yml$/.test(filePath);

    candidates.push({
      registryPath,
      fullPath: filePath,
      content,
      sourceDir: 'local',
      mtime: (await stat(filePath)).mtime,
      isPlatformYaml  // NEW: Flag to identify platform YAML files
    });
  }

  return candidates;
}
```

### 5. Prevent Base Markdown Corruption
**File:** `src/core/save/save-yml-resolution.ts` (lines 374-395)

Update `updateUniversalMarkdown` to ensure base markdown stays platform-agnostic:

```typescript
async function updateUniversalMarkdown(
  packageDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  const universalPath = join(packageDir, plan.registryPath);

  if (!(await exists(universalPath))) {
    logger.debug(`Universal markdown not found: ${universalPath}`);
    return;
  }

  // Read current content
  const content = await readFile(universalPath, 'utf-8');
  const { data: currentFrontmatter, content: body } = splitFrontmatter(content);

  // CRITICAL: Only include SHARED frontmatter in base markdown
  // Platform-specific keys should ONLY be in .{platform}.yml files
  const sharedFrontmatter = plan.sharedFrontmatter || {};

  // Verify no platform-specific keys leaked in
  const platformSpecificKeys = new Set<string>();
  for (const resolution of plan.overrideDecisions.values()) {
    if (resolution.finalFrontmatter) {
      Object.keys(resolution.finalFrontmatter).forEach(key =>
        platformSpecificKeys.add(key)
      );
    }
  }

  // Remove any platform-specific keys from shared frontmatter
  const cleanedShared = { ...sharedFrontmatter };
  for (const key of platformSpecificKeys) {
    delete cleanedShared[key];
  }

  // Write back with cleaned shared frontmatter
  const newContent = composeMarkdown(cleanedShared, body);
  await writeFile(universalPath, newContent, 'utf-8');

  logger.debug(`Updated universal markdown: ${universalPath}`);
}
```

### 6. Add Import for YAML Reading
**File:** `src/core/save/save-yml-resolution.ts` (top of file)

Ensure yaml import exists:
```typescript
import * as yaml from 'js-yaml';
import { readFile, writeFile, exists, remove } from '../../utils/fs.js';
```

### 7. Export Validation Function
**File:** `src/core/save/save-yml-resolution.ts`

```typescript
export { validateFrontmatterPlans };  // Add to exports
```

## Testing

### Test Case 1: Save Preserves Platform YAML
```bash
# Setup
mkdir -p .openpackage/packages/test/rules
echo "# Test" > .openpackage/packages/test/rules/base.md
echo "cursor_key: cursor_value" > .openpackage/packages/test/rules/base.cursor.yml
echo "claude_key: claude_value" > .openpackage/packages/test/rules/base.claude.yml

# Save package
opkg save test

# Verify: All YAML files exist in registry
ls ~/.openpackage/registry/test/*/rules/
# Should show: base.md, base.cursor.yml, base.claude.yml

# Verify: base.md has no platform-specific frontmatter
cat ~/.openpackage/registry/test/*/rules/base.md
# Should NOT contain "cursor_key" or "claude_key"

# Verify: Platform YAML files have correct content
grep "cursor_key" ~/.openpackage/registry/test/*/rules/base.cursor.yml
grep "claude_key" ~/.openpackage/registry/test/*/rules/base.claude.yml
```

### Test Case 2: Install Preserves Platform YAML
```bash
# Install from local registry
opkg install test --local

# Verify: Platform YAML files still exist in registry (not deleted)
ls ~/.openpackage/registry/test/*/rules/*.yml
# Should show both .cursor.yml and .claude.yml

# Verify: base.md in registry still platform-agnostic
cat ~/.openpackage/registry/test/*/rules/base.md
# Should NOT have platform-specific frontmatter
```

### Test Case 3: Multiple Saves Don't Corrupt
```bash
# Save multiple times
opkg save test
opkg save test
opkg save test

# Verify: Platform YAML files still intact after multiple saves
ls ~/.openpackage/registry/test/*/rules/*.yml

# Verify: base.md still platform-agnostic
cat ~/.openpackage/registry/test/*/rules/base.md
```

### Test Case 4: Platform-Specific Files in Workspace
```bash
# Create platform-specific files with different frontmatter
echo -e "---\ncursor_rule: true\n---\n# Cursor Rule" > .cursor/rules/test.mdc
echo -e "---\nclaude_rule: true\n---\n# Claude Rule" > .claude/commands/test.md

# Save package
opkg save myapp

# Verify: Each platform's YAML preserved separately
cat ~/.openpackage/registry/myapp/*/rules/test.cursor.yml
# Should contain: cursor_rule: true

cat ~/.openpackage/registry/myapp/*/commands/test.claude.yml
# Should contain: claude_rule: true

cat ~/.openpackage/registry/myapp/*/rules/test.md
# Should NOT contain platform-specific frontmatter
```

## Create Automated Test
**File:** `tests/frontmatter-bug.test.ts` (NEW)

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { savePackageCommand } from '../src/commands/save.js';
import { installPackageCommand } from '../src/commands/install.js';

test('save preserves all platform YAML files', async () => {
  const cwd = '/tmp/test-frontmatter';
  const packageName = 'test-pkg';

  // Setup
  await setupTestPackage(cwd, packageName);

  // Save
  await savePackageCommand(packageName, { workingDir: cwd });

  // Verify: All YAML files exist
  const registryPath = `~/.openpackage/registry/${packageName}/latest/rules`;
  assert(await exists(`${registryPath}/base.cursor.yml`), 'cursor.yml exists');
  assert(await exists(`${registryPath}/base.claude.yml`), 'claude.yml exists');

  // Verify: Base markdown is platform-agnostic
  const baseMd = await readFile(`${registryPath}/base.md`, 'utf-8');
  assert(!baseMd.includes('cursor_key'), 'base.md has no cursor_key');
  assert(!baseMd.includes('claude_key'), 'base.md has no claude_key');
});

test('install preserves platform YAML in registry', async () => {
  // ... similar test for install
});
```

## Success Criteria
- ✓ No platform YAML files deleted during save
- ✓ No platform YAML files deleted during install
- ✓ Base markdown files remain platform-agnostic
- ✓ Platform-specific frontmatter only in `.{platform}.yml` files
- ✓ Multiple save operations don't cause corruption
- ✓ All platform YAML files preserved across operations
- ✓ Validation function prevents accidental deletions
- ✓ Tests pass for all scenarios
