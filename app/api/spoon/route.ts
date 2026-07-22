import { NextRequest, NextResponse } from 'next/server'

const GW_BASE  = 'https://kr-gw.spooncast.net'
const API_BASE = 'https://api.spooncast.net'
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const liveId = searchParams.get('liveId')
  const accessToken = searchParams.get('accessToken')
  if (!liveId || !accessToken) return NextResponse.json({ error: '파라미터 없음' }, { status: 400 })
  const res = await fetch(`${API_BASE}/lives/${liveId}/`, {
    headers: { 'Authorization': `Bearer ${accessToken}`, 'User-Agent': CHROME_UA, 'Origin': 'https://www.spooncast.net' }
  })
  return NextResponse.json(await res.json())
}

export async function POST(req: NextRequest) {
  const { channelId, message, accessToken, roomToken } = await req.json()
  if (!channelId || !message || !accessToken || !roomToken) return NextResponse.json({ error: '파라미터 없음' }, { status: 400 })
  const res = await fetch(`${GW_BASE}/lives/${channelId}/chat/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
      'x-live-authorization': `Bearer ${roomToken}`,
      'User-Agent': CHROME_UA,
      'Origin': 'https://www.spooncast.net',
      'Referer': 'https://www.spooncast.net/',
    },
    body: JSON.stringify({ message, messageType: 'GENERAL_MESSAGE' })
  })
  return NextResponse.json(await res.json())
}
