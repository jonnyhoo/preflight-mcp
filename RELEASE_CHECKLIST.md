# Release Checklist for preflight-mcp

Use this checklist before publishing to GitHub or npm.

## Pre-Release Checks

### Core Files ✅

- [x] **README.md** - Complete with badges, installation, quick start, and examples
- [x] **LICENSE** - MIT License added
- [x] **CONTRIBUTING.md** - Development guidelines and contribution process
- [x] **CODE_OF_CONDUCT.md** - Community standards defined
- [x] **.gitignore** - Comprehensive ignore rules including .env and secrets

### Code Quality ✅

- [x] **TypeScript** - Type checking passes (`npm run typecheck`)
- [x] **Tests** - All tests pass (`npm test`)
- [x] **Build** - Project builds successfully (`npm run build`)
- [x] **Smoke Test** - End-to-end test passes (`npm run smoke`)

### Security ✅

- [x] **No Hard-coded Secrets** - No API keys, passwords, or tokens in code
- [x] **Environment Variables** - All sensitive config uses env vars
- [x] **.env in .gitignore** - Environment files are ignored
- [x] **Dependencies Audited** - Run `npm audit` and fix critical issues

### Documentation ✅

- [x] **Installation Instructions** - Clear step-by-step guide
- [x] **Quick Start Guide** - Working examples provided
- [x] **API Documentation** - All tools documented
- [x] **Environment Variables** - All config options documented
- [x] **Contributing Guide** - Link present in README
- [x] **License Info** - Clearly stated at bottom of README

### Package Configuration ✅

- [x] **package.json** - Version, description, keywords, repository URL
- [x] **Author Info** - Author/contributors listed
- [x] **License Field** - Set to "MIT"
- [x] **Repository URL** - GitHub URL configured (update YOUR-USERNAME)
- [x] **Keywords** - Relevant keywords for npm search
- [x] **Files Field** - Only dist/ is published

### Git Repository

- [ ] **Update Repository URLs** - Replace `YOUR-USERNAME` with actual GitHub username in:
  - `package.json` (repository.url, bugs.url, homepage)
  - `README.md` (Support section links)
  - `CONTRIBUTING.md` (clone URL)
- [ ] **Initial Commit** - All files committed to git
- [ ] **Git Tags** - Create version tag (e.g., `v0.1.1`)
- [ ] **Remote Added** - GitHub remote configured

### Pre-Publication

- [ ] **GitHub Repository Created** - Public repository ready
- [ ] **Repository Description** - Short description added to GitHub
- [ ] **Topics Added** - Relevant topics added to GitHub repo (mcp, ai, llm, etc.)
- [ ] **npm Account** - Have npm account ready (if publishing to npm)
- [ ] **2FA Enabled** - Two-factor auth enabled on npm

## Publishing Steps

### 1. GitHub Publication

```bash
# Update all YOUR-USERNAME placeholders with your GitHub username
# Then commit and push

git add .
git commit -m "chore: prepare for initial release"
git tag v0.1.1
git push origin main
git push origin v0.1.1
```

### 2. npm Publication (Optional)

```bash
# Login to npm
npm login

# Dry run to check what will be published
npm pack --dry-run

# Publish to npm
npm publish

# Or publish as public scoped package
npm publish --access public
```

### 3. Post-Publication

- [ ] **Test Installation** - `npm install -g preflight-mcp` works
- [ ] **Update README URLs** - Verify all links work
- [ ] **Create GitHub Release** - Add release notes on GitHub
- [ ] **Announce** - Share on relevant communities

## Security Scan Commands

Run these before publishing:

```bash
# Check for secrets in git history
git log --all --full-history --source -S "password" -S "token" -S "api_key" -S "secret"

# Audit npm dependencies
npm audit

# Check for hard-coded secrets in files
grep -r "password\|api_key\|secret\|token" src/ --exclude-dir=node_modules

# Scan with git-secrets (if installed)
git secrets --scan
```

## Final Verification

Before pushing to GitHub, verify:

1. ✅ No `.env` files in repository
2. ✅ No API keys or tokens in code
3. ✅ All tests pass
4. ✅ Build succeeds
5. ✅ Smoke test runs successfully
6. ✅ LICENSE file exists
7. ✅ README is comprehensive
8. ✅ CONTRIBUTING.md exists
9. ✅ .gitignore is complete
10. ✅ package.json has all metadata

## Notes

- **Replace YOUR-USERNAME**: Search entire project for `YOUR-USERNAME` and replace with actual GitHub username
- **Version Management**: Follow semantic versioning (MAJOR.MINOR.PATCH)
- **Breaking Changes**: Document in CHANGELOG.md when making breaking changes
- **Security**: Never commit secrets, even in "old" commits - they remain in git history

---

**Status**: ✅ Ready for publication after updating repository URLs
**Last Updated**: 2025-12-19
