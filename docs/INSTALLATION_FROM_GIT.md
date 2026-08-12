# Installing the Plugin from GitHub

## Source Installation Issues

When attempting to install the plugin directly from the `main` branch (or from source) using `opencode plugin mrsib/opencode-antigravity-auth`, Bun's embedded package manager may raise the following error:
`git dep preparation failed`

**Root Causes:**
1. The package manager attempts to prepare a Git dependency by executing lifecycle hooks (e.g., `prepublishOnly`, `prepare`, `postinstall`), which fail if build-time tools (such as `tsc` or `typescript`) are not available in the global environment.
2. A known Bun issue (`DependencyLoop`) triggers build failures when a package (e.g., `typescript`) is listed simultaneously in both `dependencies` and `devDependencies`.

Because the plugin must be compiled before use, installing raw source code requires post-install compilation. To eliminate these issues, pre-compiled release artifacts are provided in a clean build branch.

---

## Solution: Installing from the `latest` Branch

For a clean installation on any environment, use the dedicated release branch — `#latest` (or `#release`).
This branch contains only **pre-compiled distribution files** (`dist/`) and a **sanitized `package.json`** with lifecycle `scripts` and `devDependencies` completely stripped out.

### Installation Command
```bash
opencode plugin mrsib/opencode-antigravity-auth#latest -g -f
```

This command downloads the compiled release artifact and installs it globally. Because the `package.json` contains no build lifecycle scripts, Bun will not attempt to compile the source code, ensuring an instantaneous and error-free installation.

---

## For Developers: Updating the Build Branch

If you make source code changes in the `main` branch, you must re-compile the plugin and publish the updated `latest` branch.

### Step 1. Export Clean Build Artifacts
Run the export script:
```bash
npm run export:public
```

The script automatically:
1. Runs the TypeScript build (`npm run build`).
2. Copies build output (including `dist/`, `assets/`, `README.md`, `LICENSE`, `docs/`) to the `./public/` directory.
3. Generates a clean `package.json` inside `./public/`, stripping `scripts` and `devDependencies`.

### Step 2. Publish to the `latest` Branch
Navigate to the `./public/` folder and push its contents to the `latest` branch:
```bash
cd public
git init
git add .
git commit -m "release: fully clean package.json"
git push -f git@github.com:mrsib/opencode-antigravity-auth.git HEAD:latest
```

The updated release build is now immediately available for clean global installation.
