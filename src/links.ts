const videoIdPattern = /^[A-Za-z0-9_-]{11}$/
const youtubeHosts = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'])

export function parseYoutubeId(input: string): string | null {
  const value = input.trim()
  if (!value) return null
  let link: URL
  try {
    link = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : 'https://' + value)
  } catch {
    return null
  }
  if (!['https:', 'http:'].includes(link.protocol) || link.username || link.password || link.port) return null

  let id: string | null = null
  const parts = link.pathname.split('/').filter(Boolean)
  if (link.hostname === 'youtu.be' && parts.length === 1) {
    id = parts[0]
  } else if (youtubeHosts.has(link.hostname)) {
    if (parts.length === 1 && parts[0] === 'watch') id = link.searchParams.get('v')
    if (parts.length === 2 && ['shorts', 'embed', 'live'].includes(parts[0])) id = parts[1]
  }
  return id && videoIdPattern.test(id) ? id : null
}
