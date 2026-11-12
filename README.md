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

## Requirements

- Node.js (tested with 26) and npm.
- At least one agent CLI installed and signed in: `claude` or `codex`.
- Linux or macOS.

## Install

```sh
git clone https://github.com/vfabr/ife.git
cd ife
npm install
```

## Run

```sh
mkdir -p ~/ife-projects
node server.js ~/ife-projects
```

On the first run ife downloads VS Code for the web (about 37 MB) into `~/.ife/vscode`.
The server then prints a one-time link with an access token. Open it in a browser; after that
`http://127.0.0.1:7777/ide` is enough. The port is set with `IFE_PORT`.

In the ife sidebar create a project and pick a flow. Flows are downloaded from the
[flows releases](https://github.com/vfabr/flows/releases) and kept in `~/.ife/flows`.

## Files

| Path | What it is |
| --- | --- |
| `defaults.json` | all settings of ife, including the VS Code version |
| `~/.ife/vscode/` | VS Code for the web, downloaded on the first run |
| `~/.config/ife.json` | personal settings: author name, language, models |
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
