# Releasing

A `v*` tag publishes `@mu-crew/murmur` to npm. There is no token: npmjs.com
trusts this repo's `.github/workflows/release.yml` through OIDC (trusted
publishing: owner `mu-crew`, repository `murmur`, workflow `release.yml`).

1. Bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`)
   and move the CHANGELOG's Unreleased entries under it.
2. Run the gate locally before tagging; CI runs it again.

   ```sh
   npm run check
   ```

3. Commit, tag the same version, push both:

   ```sh
   git tag -a vX.Y.Z -m "murmur X.Y.Z"
   git push origin main vX.Y.Z
   ```

The workflow refuses a tag that does not match `package.json`.
