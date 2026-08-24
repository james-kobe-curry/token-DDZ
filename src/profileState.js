export const localDayKey = (date = new Date()) => [
  date.getFullYear(),
  String(date.getMonth() + 1).padStart(2, '0'),
  String(date.getDate()).padStart(2, '0'),
].join('-');

export function normalizeDailyProfile(profile, now = new Date()) {
  const today = localDayKey(now);
  if (profile.dailyDate === today) return profile;
  return { ...profile, dailyDate: today, dailyGames: 0, dailyWins: 0, claimed: [] };
}
