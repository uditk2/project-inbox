# Releasing

The public GitHub source can be run before the npm registry package is published:

```sh
npx --yes github:uditk2/project-inbox
```

## First npm release

1. Sign in with `npm login` and verify with `npm whoami`. Complete security-key or OTP checks yourself. Never put tokens in chat or source code.
2. Confirm the package name is available with `npm view project-inbox` (404 means unclaimed, not guaranteed reservable).
3. Run checks, tests, and `npm pack --dry-run`. Inspect the exact file list for secrets and private data.
4. Publish the initial version with `npm publish --access public`. npm may require a security key or one-time password.
5. In the package's npm settings, add a GitHub Actions trusted publisher: user `uditk2`, repository `project-inbox`, workflow `publish.yml`, environment `npm`. Allow direct publication for this workflow. This grants publishing authority, so the account owner must approve it.

## Following releases

Update the package version and lockfile, commit to main, then publish the matching GitHub release. The workflow runs checks and publishes with OIDC and provenance, without a long-lived npm token. A manual workflow dispatch also works for an unpublished version.

Publishing is intentionally a release action rather than every push to main. npm versions are immutable; normal pushes run CI without publishing another package version.

[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/)
