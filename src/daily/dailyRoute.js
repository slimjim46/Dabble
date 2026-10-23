export const DAILY_PATH = '/daily'
export const DAILY_GALLERY_PATH = '/daily/gallery'
export const DAILY_GALLERY_VOTE_PATH = `${DAILY_GALLERY_PATH}?tab=vote`

export function dailyView(pathname) {
  return pathname === DAILY_GALLERY_PATH ? 'gallery' : 'daily'
}

export function dailyGalleryTab(search = '') {
  return new URLSearchParams(search).get('tab') === 'vote' ? 'vote' : 'winners'
}
