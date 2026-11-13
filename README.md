# ife

ife is an editor for working in a pair with AI agents. It is VS Code for the Web served by
a small local Node server, with an extension that turns a project into a set of chats:
one per stage of work, plus chats for coders, auditors and experimenters.

- **No vendor lock-in.** Agents are the CLIs you already use (`claude`, `codex`), signed in
  with your own subscription. ife does not need API keys.
- **Chats live in the project.** Every chat, task and experiment is a file next to the code,
  so the team shares them through git.
- **Flows set the rules.** A flow describes the stages, roles, commands and texts. The
  default flow is [kredo](https://github.com/vfabr/flows).

## Download and run

Take the archive for your system from the [latest release](https://github.com/vfabr/ife/releases/latest):
Linux x64 or arm64, macOS on Apple silicon or Intel. Unpack it and run:

```sh
tar xzf ife-<version>-<system>.tar.gz
./ife/ife ~/projects
```

The archive has everything inside: Node.js, ife and VS Code. On the first run ife asks your name
and language and prints a link to open in the browser. Its settings, token and flows are kept in
the `ife` folder itself.

You need an agent CLI installed and signed in: `claude` or `codex`.

- **Linux:** the system library `libatomic` is needed. Desktop systems have it; on a minimal
  server or container install it (`dnf install libatomic` or `apt install libatomic1`).
- **macOS:** the archive is not signed yet, so macOS blocks the first start. Allow it once:
  `xattr -dr com.apple.quarantine ife`.

Windows is not supported yet.

## Development

Requirements: Node.js 26 and npm, an agent CLI (`claude` or `codex`), Linux or macOS.

```sh
git clone https://github.com/vfabr/ife.git
cd ife
npm install
```

Run:

```sh
mkdir -p ~/ife-projects
node server.js ~/ife-projects ~/ife-run
```

The first argument is the folder with projects. The second is the run folder: ife keeps there
everything that is not code. On the first run ife creates `config.json` in it, asks your name
and language in the terminal if they are not there yet, downloads VS Code
for the web (about 37 MB) and prints a one-time link with an access token. Open it in a browser;
after that `http://127.0.0.1:7777/ide` is enough.

In the ife sidebar create a project and pick a flow. Flows are downloaded from the
[flows releases](https://github.com/vfabr/flows/releases) into the run folder.

Several copies of ife can run side by side, each with its own run folder and port.

## Files

| Path | What it is |
| --- | --- |
| `defaults.json` | all settings of ife with their default values |
| `<run>/config.json` | settings of this run: port, author, language and any key of `defaults.json` |
| `<run>/token` | access token |
| `<run>/flows/` | downloaded flows |
| `<run>/vscode/` | VS Code for the web |
| `<run>/scratch/` | temporary folders of experiments |
| `<project>/ife.json` | project settings and the pinned flow version |
| `<project>/flow/` | read-only copy of the project's flow |

## VS Code build

ife uses VS Code for the web built from [microsoft/vscode](https://github.com/microsoft/vscode)
(MIT) by the `vscode` workflow of this repository. The workflow takes the version and the
left-out built-in extensions from `defaults.json` (`vscode.version`, `vscode.exclude`) and
publishes the archive as the `vscode-<version>` release. After a new build, put the archive
checksum into `vscode.digest`.

## License

ife is licensed under the [Apache License 2.0](LICENSE). Flows have their own licenses:
see the `LICENSE.md` of each flow.
