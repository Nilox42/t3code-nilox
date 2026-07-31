# T3 Code Nilox Releases

The Pi fork publishes **T3 Code Nilox** as a side-by-side Linux x86_64 desktop distribution. Its
AppImage and matching remote server tarball are built from the same commit:

- `T3-Code-Nilox-<version>-x86_64.AppImage` — unsigned Linux x86_64 desktop application.
- `t3-<version>.tgz` — matching server/CLI package used through its release URL.
- `latest-linux.yml` and related files — Nilox desktop update metadata.
- `SHA256SUMS` — checksums for the release artifacts.

The AppImage embeds the exact matching server package URL. SSH environments run that URL through
`npx`; the fork package is not installed globally and cannot replace an official global `t3`
executable.

## Isolation boundaries

T3 Code Nilox starts clean and does not probe, copy, migrate, stop, or modify official T3 Code data:

```text
Official desktop data: ~/.config/t3code
Nilox desktop data:    ~/.config/t3code-nilox

Official T3 state:     ~/.t3
Nilox T3 state:        ~/.t3-nilox
```

SSH-managed Nilox environments also use `~/.t3-nilox` on the remote host, including their runtime
file and `ssh-launch` process state. Official and Nilox servers can therefore run on the same host.

Pi's standard global state remains shared intentionally. Existing Pi `/login` authentication,
authenticated models, global skills, extensions, prompt templates, and configuration remain
available without a second setup. T3-owned Pi resume cursors, thread snapshots, settings, approvals,
and adapter state are isolated inside `~/.t3-nilox/userdata`.

Explicit `T3CODE_HOME`, `XDG_CONFIG_HOME`, and desktop application-ID development overrides still
take precedence. Manually pointing Nilox at an official path defeats this isolation.

## Create a release

Create the next semver-compatible tag from `feature/pi-agent-support`:

```bash
git switch feature/pi-agent-support
git push origin feature/pi-agent-support
git tag pi-v0.0.29-pi.2
git push origin pi-v0.0.29-pi.2
```

Pushing the tag starts `.github/workflows/pi-release.yml`. The historical
`pi-v0.0.29-pi.1` release remains available and must not be moved or deleted.

## Launch the AppImage

Download the AppImage and checksum file, then run:

```bash
sha256sum --check SHA256SUMS --ignore-missing
chmod +x T3-Code-Nilox-0.0.29-pi.2-x86_64.AppImage
./T3-Code-Nilox-0.0.29-pi.2-x86_64.AppImage
```

No environment wrapper is required.

## Connect to an LXC over SSH

On the LXC:

1. Install Node.js `^22.16 || ^23.11 || >=24.10`.
2. Ensure the laptop can connect to the container over SSH.
3. Install Pi Agent 0.82 or newer:

   ```bash
   npm install --global @earendil-works/pi-coding-agent
   ```

4. Run `pi`, use `/login`, and confirm the desired models are available.
5. Verify that `node`, `npm` or `npx`, and `pi` are visible to a non-interactive SSH shell.

In T3 Code Nilox, open **Settings → Connections → Remote Environments → Add environment**, select
SSH, and enter the remote target. The desktop launches the matching release tarball with
`--base-dir "$HOME/.t3-nilox"` and stores all launcher state below the same Nilox directory.

## Direct Tailscale/manual alternative

Run the release package directly from its URL rather than installing it globally:

```bash
npx --yes \
  https://github.com/Nilox42/t3code-nilox/releases/download/pi-v0.0.29-pi.2/t3-0.0.29-pi.2.tgz \
  serve --host "$(tailscale ip -4)" --base-dir "$HOME/.t3-nilox"
```

Bind only to a trusted private address. Do not use `t3 service install` for the fork yet: its
background-service and systemd unit names are not namespaced. SSH-managed remote launch is the
supported fully isolated mode.

## Reset only Nilox

After quitting T3 Code Nilox and stopping its SSH-managed environments, remove only:

```bash
rm -rf -- "$HOME/.config/t3code-nilox" "$HOME/.t3-nilox"
```

On a remote host, remove only `$HOME/.t3-nilox` after confirming its Nilox process has stopped.
Official paths (`~/.config/t3code` and `~/.t3`) are unaffected.
