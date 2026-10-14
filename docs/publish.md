# Publish Context Atlas

The source repository is [qsxustc/context-atlas](https://github.com/qsxustc/context-atlas), and its configured Pages address is [qsxustc.github.io/context-atlas](https://qsxustc.github.io/context-atlas/). Use the steps below when publishing your own fork to GitHub Pages or another static host.

## A new GitHub repository

Create an **empty** repository called `context-atlas` in your GitHub account. Choose Public if you want other people to discover, use and star it. Do not initialize the remote with a README, license or gitignore: this project already includes all three.

From this project directory, add the GitHub remote and push the existing main branch:

```sh
git remote add github https://github.com/YOUR_USERNAME/context-atlas.git
git push -u github main
```

Replace `YOUR_USERNAME` with your actual account. The first push requires your existing GitHub authentication. If the checkout already has a remote named `github`, inspect it with `git remote -v` before changing it. If you already initialized a remote repository, reconcile its commit history before pushing; do not force-push over unrelated work.

An existing checkout may already have an `origin` remote. The separate `github` remote lets you publish to another repository without replacing that connection. GitHub's downloaded source ZIP has no Git history; if using it, initialize Git first:

```sh
git init -b main
git add .
git commit -m "Build Context Atlas visual context workbench"
```

## GitHub Pages

In repository settings, open **Pages → Build and deployment → Source** and select **GitHub Actions**. The supplied Pages workflow builds and publishes `dist/` on a push to `main` or a manual run. It uses relative asset paths, so repository subpath hosting is supported.

After deployment succeeds:

1. Add the confirmed Pages URL to the repository's website field and README.
2. Update the app header's GitHub link to your fork's confirmed repository URL.
3. If your fork changes the interface, replace the README screenshot with an actual screenshot of that version.
4. Use the reviewed launch drafts in [launch.md](launch.md). No social posts have been sent automatically.

## Other static hosts

Run `npm run build` and upload the contents of `dist/`. The app needs no environment variables, application backend, account or API keys. Imported repositories remain browser-local.
