const base = (repository: string) => `https://github.com/${repository}`

export const commitUrl = (repository: string, sha: string) => `${base(repository)}/commit/${sha}`
export const pullRequestUrl = (repository: string, number: number) => `${base(repository)}/pull/${number}`
export const treeUrl = (repository: string, branch: string) => `${base(repository)}/tree/${branch}`
export const compareUrl = (repository: string, from: string, to: string) => `${base(repository)}/compare/${from}...${to}`
