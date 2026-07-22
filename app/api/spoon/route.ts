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
  try {
    const body = await req.json()
    console.log('[spoon API] 받은 body:', JSON.stringify(body))
    
    const { channelId, message, accessToken, roomToken } = body
    
    if (!channelId || !message || !accessToken || !roomToken) {
      console.log('[spoon API] 파라미터 없음:', { channelId: !!channelId, message: !!message, accessToken: !!accessToken, roomToken: !!roomToken })
      return NextResponse.json({ error: '파라미터 없음' }, { status: 400 })
    }

    const url = `${GW_BASE}/lives/${channelId.trim()}/chat/message`
    console.log('[spoon API] 요청 URL:', url)

    const res = await fetch(url, {
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

    const data = await res.json()
    console.log('[spoon API] 스푼 응답 status:', res.status, '응답:', JSON.stringify(data))
    
    return NextResponse.json({ status: res.status, data })
  } catch(e: any) {
    console.log('[spoon API] 오류:', e.message)
    return NextResponse.json({ error: e.message }, { status: 500 })
  }
}
