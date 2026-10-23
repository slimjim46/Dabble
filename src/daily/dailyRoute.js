export const DAILY_PATH = '/daily'
export const DAILY_GALLERY_PATH = '/daily/gallery'

export function dailyView(pathname) {
  return pathname === DAILY_GALLERY_PATH ? 'gallery' : 'daily'
}
