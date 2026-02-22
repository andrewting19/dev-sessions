/**
 * League of Legends champion names and roles for generating human-friendly IDs.
 */
export const CHAMPIONS = [
  'ahri', 'akali', 'alistar', 'amumu', 'anivia', 'annie', 'ashe', 'azir',
  'bard', 'blitz', 'brand', 'braum', 'cait', 'camille', 'cass', 'chogath',
  'corki', 'darius', 'diana', 'draven', 'mundo', 'ekko', 'elise', 'evelynn',
  'ezreal', 'fiddle', 'fiora', 'fizz', 'galio', 'garen', 'gnar', 'gragas',
  'graves', 'hecarim', 'heimer', 'illaoi', 'irelia', 'ivern', 'janna', 'jarvan',
  'jax', 'jayce', 'jhin', 'jinx', 'kaisa', 'kalista', 'karma', 'karthus',
  'kassadin', 'kata', 'kayle', 'kayn', 'kennen', 'khazix', 'kindred', 'kled',
  'kogmaw', 'leblanc', 'lee', 'leona', 'lissandra', 'lucian', 'lulu', 'lux',
  'malph', 'malz', 'mao', 'master-yi', 'mf', 'morgana', 'nami', 'nasus',
  'nautilus', 'neeko', 'nidalee', 'nocturne', 'nunu', 'olaf', 'orianna', 'ornn',
  'pantheon', 'poppy', 'pyke', 'qiyana', 'quinn', 'rakan', 'rammus', 'reksai',
  'renekton', 'rengar', 'riven', 'rumble', 'ryze', 'sejuani', 'senna', 'sett',
  'shaco', 'shen', 'shyvana', 'singed', 'sion', 'sivir', 'skarner', 'sona',
  'soraka', 'swain', 'sylas', 'syndra', 'tahm', 'taliyah', 'talon', 'taric',
  'teemo', 'thresh', 'tristana', 'trundle', 'tryndamere', 'tf', 'twitch', 'udyr',
  'urgot', 'varus', 'vayne', 'veigar', 'velkoz', 'vi', 'viego', 'viktor',
  'vladimir', 'volibear', 'warwick', 'wukong', 'xayah', 'xerath', 'xin',
  'yasuo', 'yone', 'yorick', 'yuumi', 'zac', 'zed', 'zeri', 'ziggs',
  'zilean', 'zoe', 'zyra'
] as const;

export const ROLES = ['top', 'jg', 'mid', 'adc', 'sup'] as const;

const TMUX_SESSION_PREFIX = 'dev-';

/**
 * Format: "riven-jg", "blitz-adc", etc.
 */
export function generateChampionId(random: () => number = Math.random): string {
  const champion = CHAMPIONS[Math.floor(random() * CHAMPIONS.length)];
  const role = ROLES[Math.floor(random() * ROLES.length)];
  return `${champion}-${role}`;
}

export function toTmuxSessionName(championId: string): string {
  return `${TMUX_SESSION_PREFIX}${championId}`;
}

export function fromTmuxSessionName(tmuxName: string): string | null {
  if (!tmuxName.startsWith(TMUX_SESSION_PREFIX)) {
    return null;
  }

  const rawId = tmuxName.slice(TMUX_SESSION_PREFIX.length);
  return rawId.length > 0 ? rawId : null;
}
