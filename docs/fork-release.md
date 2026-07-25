# Pi Fork Releases

The Pi fork release workflow builds the Linux desktop and remote server from the same commit and
publishes both files in one GitHub release:

- `T3-Code-<version>-x86_64.AppImage` — Linux x64 desktop application.
- `t3-<version>.tgz` — installable T3 server/CLI package for a Linux remote host.
- `latest-linux.yml` and related files — desktop update metadata.
- `SHA256SUMS` — checksums for the published artifacts.

The AppImage embeds the matching server package URL. When the desktop application's SSH environment
flow starts T3 on a remote host, it prefers that package over an existing global `t3` command. This
keeps the desktop and remote protocol versions aligned without publishing the fork to npm.

## Create a Release

Create a semver-compatible tag with the `pi-v` prefix from `feature/pi-agent-support`:

```bash
git switch feature/pi-agent-support
git push origin feature/pi-agent-support
git tag pi-v0.0.29-pi.1
git push origin pi-v0.0.29-pi.1
```

Pushing the tag starts `.github/workflows/pi-release.yml` on a standard GitHub-hosted Linux runner.
The workflow builds an unsigned x64 AppImage and server package, then creates the corresponding
release in the fork. Increment the suffix for later builds, for example `0.0.29-pi.2`.

The workflow can also be started manually with a version input after the workflow exists on the
repository's default branch.

## Install the AppImage

Download the AppImage and checksum file from the release, then:

```bash
sha256sum --check SHA256SUMS --ignore-missing
chmod +x T3-Code-0.0.29-pi.1-x86_64.AppImage
./T3-Code-0.0.29-pi.1-x86_64.AppImage
```

For isolated fork state alongside an official installation:

```bash
T3CODE_HOME="$HOME/.t3-pi" \
XDG_CONFIG_HOME="$HOME/.config/t3code-pi" \
./T3-Code-0.0.29-pi.1-x86_64.AppImage
```

The locally built AppImage points desktop updates at releases in this fork, not the upstream
repository.

## Connect to an LXC over SSH

The recommended flow does not require a globally installed T3 server package.

On the LXC:

1. Install a supported Node.js version: `^22.16 || ^23.11 || >=24.10`.
2. Ensure the laptop can connect to the container over SSH.
3. Install Pi Agent 0.82 or newer:

   ```bash
   npm install --global @earendil-works/pi-coding-agent
   ```

4. Run `pi`, use `/login`, and confirm the desired models are available. Environment-variable
   authentication is also supported.
5. Ensure `node`, `npm` or `npx`, and `pi` are available to a non-interactive SSH shell:

   ```bash
   ssh user@lxc-host 'sh -lc "command -v node && node --version && command -v npm && command -v pi && pi --version"'
   ```

In the AppImage, open **Settings → Connections → Remote Environments → Add environment**, choose
SSH, and enter `user@lxc-host`. The desktop app downloads the matching `t3-<version>.tgz`, launches
the server on the LXC, creates a local SSH port forward, and saves the paired environment.

Projects, git state, terminals, Pi sessions, and Pi authentication remain on the LXC. The laptop is
only the client.

## Direct Tailscale Alternative

To run the release package as a persistent or directly reachable server, download the `.tgz` on the
LXC and install it:

```bash
npm install --global ./t3-0.0.29-pi.1.tgz
t3 serve --host "$(tailscale ip -4)"
```

Use the printed pairing URL in the desktop app. Bind only to a trusted private address; do not expose
the unauthenticated pairing endpoint directly to the public internet.

On a systemd-based LXC, `t3 service install` can manage a background service. SSH-managed launch is
usually simpler because the desktop application automatically selects the matching fork package.
