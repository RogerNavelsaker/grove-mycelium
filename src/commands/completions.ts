import type { Command } from "commander";
import { printError } from "../output.ts";

const BASH_COMPLETIONS = `
_mc_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local commands="init decompose spawn status watch stop tasks show retry pool logs doctor prime sync upgrade completions"
  COMPREPLY=( $(compgen -W "$commands" -- "$cur") )
}
complete -F _mc_completions mc
complete -F _mc_completions mycelium
`;

const ZSH_COMPLETIONS = `
#compdef mc mycelium

_mc() {
  local commands=(
    'init:Initialize .mycelium/ directory and task pool'
    'decompose:Recursive decomposition of intent into atomic tasks'
    'spawn:Spin up tmux workers to claim and execute tasks'
    'status:Task pool overview and worker status'
    'watch:Monitor state surface and trigger re-decomposition'
    'stop:Terminate worker(s)'
    'tasks:List tasks with filtering'
    'show:Show detailed task or intent view'
    'retry:Reset a failed task to pending'
    'pool:Task pool management'
    'logs:View worker execution logs'
    'doctor:Health checks'
    'prime:Inject session context'
    'sync:Stage and commit .mycelium/ changes'
    'upgrade:Upgrade to latest version'
    'completions:Output shell completion script'
  )
  _describe 'command' commands
}

compdef _mc mc
compdef _mc mycelium
`;

const FISH_COMPLETIONS = `
set -l commands init decompose spawn status watch stop tasks show retry pool logs doctor prime sync upgrade completions
complete -c mc -f
complete -c mycelium -f
for cmd in $commands
  complete -c mc -n "not __fish_seen_subcommand_from $commands" -a $cmd
  complete -c mycelium -n "not __fish_seen_subcommand_from $commands" -a $cmd
end
`;

export function register(program: Command): void {
	program
		.command("completions")
		.argument("<shell>", "Shell type (bash, zsh, fish)")
		.description("Output shell completion script")
		.action(async (shell: string) => {
			switch (shell) {
				case "bash":
					console.log(BASH_COMPLETIONS.trim());
					break;
				case "zsh":
					console.log(ZSH_COMPLETIONS.trim());
					break;
				case "fish":
					console.log(FISH_COMPLETIONS.trim());
					break;
				default:
					printError(`Unsupported shell: ${shell}. Use bash, zsh, or fish.`);
					process.exitCode = 1;
			}
		});
}
