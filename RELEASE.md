# Release Process

## One-Time Setup

1. Create the npm package and reserve the name:

   ```bash
   npm login
   npm publish --dry-run
   ```

2. Add the `NPM_TOKEN` repository secret in GitHub:
   - Go to `Settings` -> `Secrets and variables` -> `Actions`
   - Create a new secret named `NPM_TOKEN`
   - Use an npm automation or granular access token with publish access for this package

3. Push the GitHub Actions workflows in `.github/workflows/`

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
   - publish to npm with provenance

## Manual Dry Run In GitHub Actions

You can also run the `Publish` workflow manually from the Actions tab with `dry_run=true` to validate the packaging flow without releasing.

## Notes

- The package name in `package.json` should be confirmed before the first real publish
- The publish workflow assumes this is a public npm package and uses `--access public`
- If you prefer GitHub Releases as the trigger later, the workflow can be changed easily
