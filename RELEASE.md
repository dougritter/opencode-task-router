# Release Process

## One-Time Setup

1. Create the npm package and reserve the name:

   ```bash
   npm login
   npm publish --dry-run
   ```

2. Push the GitHub Actions workflows in `.github/workflows/`

3. In npm, configure trusted publishing for this package:
   - Open the package page on npm
   - Go to `Settings` -> `Trusted publishers`
   - Choose `GitHub Actions`
   - Set:
     - `Organization or user`: `dougritter`
     - `Repository`: `opencode-task-router`
     - `Workflow filename`: `publish.yml`
     - `Environment name`: leave blank unless you add a GitHub environment for releases

4. After trusted publishing works, remove any old publish tokens and optionally set package publishing access to require 2FA and disallow tokens

## Bootstrap Note

Trusted publishing is configured from the npm package settings UI. If npm does not let you configure a trusted publisher until the package exists, publish the first release manually with a one-off publish-capable token, then switch all future releases to trusted publishing.

## Recommended Publish Flow

1. Update `package.json` version
2. Run local verification:

   ```bash
   npm test
   npm publish --dry-run
   ```

3. Commit and merge to `main`
4. Create and push a version tag that matches `package.json`

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

5. The `Publish` GitHub Action will:
   - install dependencies
   - run tests
   - verify the git tag matches `package.json`
   - publish to npm with GitHub OIDC trusted publishing
   - attach provenance automatically

## Manual Dry Run In GitHub Actions

You can also run the `Publish` workflow manually from the Actions tab with `dry_run=true` to validate the packaging flow without releasing.

## Notes

- The package name in `package.json` should be confirmed before the first real publish
- The publish workflow assumes this is a public npm package and uses `--access public`
- Trusted publishing requires the npm package settings to match this repo and workflow filename exactly
- If you prefer GitHub Releases as the trigger later, the workflow can be changed easily
