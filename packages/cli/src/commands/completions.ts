export type CompletionShell = 'zsh' | 'bash' | 'fish' | 'powershell' | 'pwsh' | 'nushell' | 'nu'

export interface CompletionsCommandArgs {
  shell?: string
}

export function completionsCommand(args: CompletionsCommandArgs = {}): number {
  const shell = args.shell?.toLowerCase()
  if (shell === 'zsh') {
    process.stdout.write(ZSH_COMPLETION)
    return 0
  }
  if (shell === 'bash') {
    process.stdout.write(BASH_COMPLETION)
    return 0
  }
  if (shell === 'fish') {
    process.stdout.write(FISH_COMPLETION)
    return 0
  }
  if (shell === 'powershell' || shell === 'pwsh') {
    process.stdout.write(POWERSHELL_COMPLETION)
    return 0
  }
  if (shell === 'nushell' || shell === 'nu') {
    process.stdout.write(NUSHELL_COMPLETION)
    return 0
  }

  process.stderr.write('Usage: choirmaster completions <zsh|bash|fish|powershell|nushell>\n')
  return 64
}

const ZSH_COMPLETION = `#compdef choirmaster cm

_choirmaster() {
  local -a commands
  commands=(
    'doctor:check repo, manifest, agents, gates, and network'
    'draft:create an editable markdown plan skeleton'
    'init:scaffold .choirmaster in the current repo'
    'plan:decompose a markdown plan into a tasks file'
    'run:run a markdown plan or tasks file'
    'completions:print shell completion script'
  )

  local cur="$words[$CURRENT]"
  if (( CURRENT == 2 )); then
    _describe 'command' commands
    return
  fi

  case "$words[2]" in
    plan|run)
      if [[ "$cur" == @* ]]; then
        local -a matches
        matches=("\${(@f)$($words[1] __complete markdown "$cur" 2>/dev/null)}")
        compadd -a matches
        return
      fi
      _files
      ;;
    completions)
      compadd zsh bash fish powershell pwsh nushell nu
      ;;
    draft)
      compadd -- --from --output --force -f
      ;;
    doctor)
      compadd -- --cwd --skip-network --offline
      ;;
    init)
      compadd -- --force
      ;;
  esac
}

compdef _choirmaster choirmaster
compdef _choirmaster cm
`

const BASH_COMPLETION = `_choirmaster_completion() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local subcommand="\${COMP_WORDS[1]}"

  if [[ "\${COMP_CWORD}" -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "doctor draft init plan run completions" -- "$cur") )
    return 0
  fi

  case "$subcommand" in
    plan|run)
      if [[ "$cur" == @* ]]; then
        mapfile -t COMPREPLY < <("\${COMP_WORDS[0]}" __complete markdown "$cur" 2>/dev/null)
        return 0
      fi
      COMPREPLY=( $(compgen -f -- "$cur") )
      ;;
    completions)
      COMPREPLY=( $(compgen -W "zsh bash fish powershell pwsh nushell nu" -- "$cur") )
      ;;
    draft)
      COMPREPLY=( $(compgen -W "--from --output --force -f" -- "$cur") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--cwd --skip-network --offline" -- "$cur") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--force" -- "$cur") )
      ;;
  esac
}

complete -F _choirmaster_completion choirmaster
complete -F _choirmaster_completion cm
`

const FISH_COMPLETION = `function __choirmaster_complete_markdown
  set -l token (commandline -ct)
  if string match -q '@*' -- $token
    set -l words (commandline -opc)
    command $words[1] __complete markdown $token 2>/dev/null
  end
end

complete -c choirmaster -f -n "not __fish_seen_subcommand_from doctor draft init plan run completions" -a "doctor draft init plan run completions"
complete -c cm -f -n "not __fish_seen_subcommand_from doctor draft init plan run completions" -a "doctor draft init plan run completions"

complete -c choirmaster -f -n "__fish_seen_subcommand_from plan run; and string match -q '@*' -- (commandline -ct)" -a "(__choirmaster_complete_markdown)"
complete -c cm -f -n "__fish_seen_subcommand_from plan run; and string match -q '@*' -- (commandline -ct)" -a "(__choirmaster_complete_markdown)"

complete -c choirmaster -n "__fish_seen_subcommand_from completions" -a "zsh bash fish powershell pwsh nushell nu"
complete -c cm -n "__fish_seen_subcommand_from completions" -a "zsh bash fish powershell pwsh nushell nu"

complete -c choirmaster -n "__fish_seen_subcommand_from draft" -l from -r
complete -c choirmaster -n "__fish_seen_subcommand_from draft" -l output -r
complete -c choirmaster -n "__fish_seen_subcommand_from draft" -l force
complete -c choirmaster -n "__fish_seen_subcommand_from draft" -s f
complete -c cm -n "__fish_seen_subcommand_from draft" -l from -r
complete -c cm -n "__fish_seen_subcommand_from draft" -l output -r
complete -c cm -n "__fish_seen_subcommand_from draft" -l force
complete -c cm -n "__fish_seen_subcommand_from draft" -s f

complete -c choirmaster -n "__fish_seen_subcommand_from doctor" -l cwd -r
complete -c choirmaster -n "__fish_seen_subcommand_from doctor" -l skip-network
complete -c choirmaster -n "__fish_seen_subcommand_from doctor" -l offline
complete -c cm -n "__fish_seen_subcommand_from doctor" -l cwd -r
complete -c cm -n "__fish_seen_subcommand_from doctor" -l skip-network
complete -c cm -n "__fish_seen_subcommand_from doctor" -l offline

complete -c choirmaster -n "__fish_seen_subcommand_from init" -l force
complete -c cm -n "__fish_seen_subcommand_from init" -l force
`

const POWERSHELL_COMPLETION = `Register-ArgumentCompleter -Native -CommandName choirmaster,cm -ScriptBlock {
  param($wordToComplete, $commandAst, $cursorPosition)

  $words = @($commandAst.CommandElements | ForEach-Object { $_.Extent.Text })
  $commandName = if ($words.Count -gt 0) { $words[0] } else { 'choirmaster' }
  $subcommand = if ($words.Count -gt 1) { $words[1].Trim("'\\\"") } else { '' }

  function New-ChoirCompletion($value, $kind = 'ParameterValue') {
    $type = [System.Management.Automation.CompletionResultType]::$kind
    [System.Management.Automation.CompletionResult]::new($value, $value, $type, $value)
  }

  $knownCommands = @('doctor', 'draft', 'init', 'plan', 'run', 'completions')
  if ($words.Count -le 1 -or ($words.Count -le 2 -and $knownCommands -notcontains $subcommand)) {
    $knownCommands |
      Where-Object { $_ -like "$wordToComplete*" } |
      ForEach-Object { New-ChoirCompletion $_ }
    return
  }

  switch ($subcommand) {
    'plan' {
      if ($wordToComplete.StartsWith('@')) {
        & $commandName __complete markdown $wordToComplete 2>$null |
          ForEach-Object { New-ChoirCompletion $_ }
      }
    }
    'run' {
      if ($wordToComplete.StartsWith('@')) {
        & $commandName __complete markdown $wordToComplete 2>$null |
          ForEach-Object { New-ChoirCompletion $_ }
      }
    }
    'completions' {
      'zsh', 'bash', 'fish', 'powershell', 'pwsh', 'nushell', 'nu' |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { New-ChoirCompletion $_ }
    }
    'draft' {
      '--from', '--output', '--force', '-f' |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { New-ChoirCompletion $_ 'ParameterName' }
    }
    'doctor' {
      '--cwd', '--skip-network', '--offline' |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { New-ChoirCompletion $_ 'ParameterName' }
    }
    'init' {
      '--force' |
        Where-Object { $_ -like "$wordToComplete*" } |
        ForEach-Object { New-ChoirCompletion $_ 'ParameterName' }
    }
  }
}
`

const NUSHELL_COMPLETION = `def "nu-complete choirmaster commands" [] {
  [doctor draft init plan run completions]
}

def "nu-complete choirmaster shells" [] {
  [zsh bash fish powershell pwsh nushell nu]
}

def "nu-complete choirmaster markdown" [context: string] {
  let words = ($context | split row ' ')
  let bin = ($words | first)
  let token = ($words | last)
  if ($token | str starts-with '@') {
    ^$bin __complete markdown $token | lines
  } else {
    []
  }
}

extern "choirmaster" [
  command?: string@"nu-complete choirmaster commands"
]

extern "cm" [
  command?: string@"nu-complete choirmaster commands"
]

extern "choirmaster plan" [
  plan?: string@"nu-complete choirmaster markdown"
  --output: string
  --force(-f)
]

extern "choirmaster draft" [
  goal?: string
  --from: string
  --output: string
  --force(-f)
]

extern "cm draft" [
  goal?: string
  --from: string
  --output: string
  --force(-f)
]

extern "cm plan" [
  plan?: string@"nu-complete choirmaster markdown"
  --output: string
  --force(-f)
]

extern "choirmaster run" [
  input?: string@"nu-complete choirmaster markdown"
  --resume: string
  --continue-on-blocked
  --reuse-worktree
  --no-auto-merge
]

extern "cm run" [
  input?: string@"nu-complete choirmaster markdown"
  --resume: string
  --continue-on-blocked
  --reuse-worktree
  --no-auto-merge
]

extern "choirmaster completions" [
  shell?: string@"nu-complete choirmaster shells"
]

extern "cm completions" [
  shell?: string@"nu-complete choirmaster shells"
]
`
