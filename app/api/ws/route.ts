import { NextRequest, NextResponse } from 'next/server'

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const accessToken = searchParams.get('accessToken')
  const roomToken = searchParams.get('roomToken')
  const channelId = searchParams.get('channelId')

  if (!accessToken || !roomToken || !channelId) {
    return NextResponse.json({ error: '파라미터 없음' }, { status: 400 })
  }

  return NextResponse.json({
    wsUrl: `wss://kr-wala.spooncast.net/ws?token=${accessToken}`,
    channelId,
    roomToken,
  })
}
