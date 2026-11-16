// monster2.js — 🐾 몬스터잡기 2세대 (공식 웹·PC 같은 파일)
//  · 포켓몬 2세대 100마리 자동 추가 (DJ가 넣은 몬스터는 그대로 · 이로치/거다이맥스도 다 나와요)
//  · 🥚 알 부화 · 🌙 낮/밤 출현 · 💞 친밀도 진화 · 🔁 교환(교환 진화) · 🏟️ 체육관/배지 · 🏆 토너먼트
//  · 🎣 시간 한정 출현(이벤트) · 🐾 따라다니기 · 🏪 팔기/경매 · 📜 도감 완성 보상 · 🎁 지닌 물건 · 🔤 안농 수집
//  유저 데이터는 몬스터 공용 저장소(globalMonsterDex)의 새 칸(g2eggs·g2friend·g2badges·g2items·g2unown·g2awards)에 둬서
//  PC 프로그램과 자동으로 같이 맞춰져요. 포인트는 웹 도감 포인트(분해·레벨업에 쓰는 그 포인트)를 같이 써요.
'use strict';

const GEN2 = [{"id": "pkmn-152", "name": "치코리타", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/152.png", "weight": 34, "catchRate": 50, "power": 318, "trait": "도감 152번 · 타입 풀 · HP 45 / 공격 49 / 방어 65 / 특공 49 / 특방 65 / 스피드 45", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "pkmn-153", "evolveCount": 16, "legendary": false}, {"id": "pkmn-153", "name": "베이리프", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/153.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 153번 · 타입 풀 · HP 60 / 공격 62 / 방어 80 / 특공 63 / 특방 80 / 스피드 60", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "pkmn-154", "evolveCount": 32, "legendary": false}, {"id": "pkmn-154", "name": "메가니움", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/154.png", "weight": 16, "catchRate": 50, "power": 525, "trait": "도감 154번 · 타입 풀 · HP 80 / 공격 82 / 방어 100 / 특공 83 / 특방 100 / 스피드 80", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-155", "name": "브케인", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/155.png", "weight": 34, "catchRate": 50, "power": 309, "trait": "도감 155번 · 타입 불꽃 · HP 39 / 공격 52 / 방어 43 / 특공 60 / 특방 50 / 스피드 65", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-156", "evolveCount": 16, "legendary": false}, {"id": "pkmn-156", "name": "마그케인", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/156.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 156번 · 타입 불꽃 · HP 58 / 공격 64 / 방어 58 / 특공 80 / 특방 65 / 스피드 80", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-157", "evolveCount": 32, "legendary": false}, {"id": "pkmn-157", "name": "블레이범", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/157.png", "weight": 16, "catchRate": 50, "power": 534, "trait": "도감 157번 · 타입 불꽃 · HP 78 / 공격 84 / 방어 78 / 특공 109 / 특방 85 / 스피드 100", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-158", "name": "리아코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/158.png", "weight": 34, "catchRate": 50, "power": 314, "trait": "도감 158번 · 타입 물 · HP 50 / 공격 65 / 방어 64 / 특공 44 / 특방 48 / 스피드 43", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-159", "evolveCount": 16, "legendary": false}, {"id": "pkmn-159", "name": "엘리게이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/159.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 159번 · 타입 물 · HP 65 / 공격 80 / 방어 80 / 특공 59 / 특방 63 / 스피드 58", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-160", "evolveCount": 32, "legendary": false}, {"id": "pkmn-160", "name": "장크로다일", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/160.png", "weight": 16, "catchRate": 50, "power": 530, "trait": "도감 160번 · 타입 물 · HP 85 / 공격 105 / 방어 100 / 특공 79 / 특방 83 / 스피드 78", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-161", "name": "꼬리선", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/161.png", "weight": 42, "catchRate": 50, "power": 215, "trait": "도감 161번 · 타입 노말 · HP 35 / 공격 46 / 방어 34 / 특공 35 / 특방 45 / 스피드 20", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-162", "evolveCount": 16, "legendary": false}, {"id": "pkmn-162", "name": "다꼬리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/162.png", "weight": 25, "catchRate": 50, "power": 415, "trait": "도감 162번 · 타입 노말 · HP 85 / 공격 76 / 방어 64 / 특공 45 / 특방 55 / 스피드 90", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-163", "name": "부우부", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/163.png", "weight": 38, "catchRate": 50, "power": 262, "trait": "도감 163번 · 타입 노말/비행 · HP 60 / 공격 30 / 방어 30 / 특공 36 / 특방 56 / 스피드 50", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-164", "evolveCount": 16, "legendary": false}, {"id": "pkmn-164", "name": "야부엉", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/164.png", "weight": 22, "catchRate": 50, "power": 452, "trait": "도감 164번 · 타입 노말/비행 · HP 100 / 공격 50 / 방어 50 / 특공 86 / 특방 96 / 스피드 70", "types": ["노말", "비행"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-165", "name": "레디바", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/165.png", "weight": 38, "catchRate": 50, "power": 265, "trait": "도감 165번 · 타입 벌레/비행 · HP 40 / 공격 20 / 방어 30 / 특공 40 / 특방 80 / 스피드 55", "types": ["벌레", "비행"], "moves": ["더블니들", "연속자르기", "메가혼", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-166", "evolveCount": 16, "legendary": false}, {"id": "pkmn-166", "name": "레디안", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/166.png", "weight": 28, "catchRate": 50, "power": 390, "trait": "도감 166번 · 타입 벌레/비행 · HP 55 / 공격 35 / 방어 50 / 특공 55 / 특방 110 / 스피드 85", "types": ["벌레", "비행"], "moves": ["더블니들", "연속자르기", "메가혼", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-167", "name": "페이검", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/167.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 167번 · 타입 벌레/독 · HP 40 / 공격 60 / 방어 40 / 특공 40 / 특방 40 / 스피드 30", "types": ["벌레", "독"], "moves": ["더블니들", "연속자르기", "메가혼", "독침", "오물공격", "독찌르기"], "evolvesTo": "pkmn-168", "evolveCount": 16, "legendary": false}, {"id": "pkmn-168", "name": "아리아도스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/168.png", "weight": 27, "catchRate": 50, "power": 400, "trait": "도감 168번 · 타입 벌레/독 · HP 70 / 공격 90 / 방어 70 / 특공 60 / 특방 70 / 스피드 40", "types": ["벌레", "독"], "moves": ["더블니들", "연속자르기", "메가혼", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-169", "name": "크로뱃", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/169.png", "weight": 15, "catchRate": 50, "power": 535, "trait": "도감 169번 · 타입 독/비행 · HP 85 / 공격 90 / 방어 80 / 특공 70 / 특방 80 / 스피드 130", "types": ["독", "비행"], "moves": ["독침", "오물공격", "독찌르기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-170", "name": "초라기", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/170.png", "weight": 32, "catchRate": 50, "power": 330, "trait": "도감 170번 · 타입 물/전기 · HP 75 / 공격 38 / 방어 38 / 특공 56 / 특방 56 / 스피드 67", "types": ["물", "전기"], "moves": ["물대포", "파도타기", "하이드로펌프", "전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-171", "evolveCount": 16, "legendary": false}, {"id": "pkmn-171", "name": "랜턴", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/171.png", "weight": 22, "catchRate": 50, "power": 460, "trait": "도감 171번 · 타입 물/전기 · HP 125 / 공격 58 / 방어 58 / 특공 76 / 특방 76 / 스피드 67", "types": ["물", "전기"], "moves": ["물대포", "파도타기", "하이드로펌프", "전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-172", "name": "피츄", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/172.png", "weight": 43, "catchRate": 50, "power": 205, "trait": "도감 172번 · 타입 전기 · HP 20 / 공격 40 / 방어 15 / 특공 35 / 특방 35 / 스피드 60", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-025", "evolveCount": 10, "legendary": false}, {"id": "pkmn-173", "name": "삐", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/173.png", "weight": 42, "catchRate": 50, "power": 218, "trait": "도감 173번 · 타입 페어리 · HP 50 / 공격 25 / 방어 28 / 특공 45 / 특방 55 / 스피드 15", "types": ["페어리"], "moves": ["천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "pkmn-035", "evolveCount": 10, "legendary": false}, {"id": "pkmn-174", "name": "푸푸린", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/174.png", "weight": 42, "catchRate": 50, "power": 210, "trait": "도감 174번 · 타입 노말/페어리 · HP 90 / 공격 30 / 방어 15 / 특공 40 / 특방 20 / 스피드 15", "types": ["노말", "페어리"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "pkmn-039", "evolveCount": 10, "legendary": false}, {"id": "pkmn-175", "name": "토게피", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/175.png", "weight": 40, "catchRate": 50, "power": 245, "trait": "도감 175번 · 타입 페어리 · HP 35 / 공격 20 / 방어 65 / 특공 40 / 특방 65 / 스피드 20", "types": ["페어리"], "moves": ["천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "pkmn-176", "evolveCount": 10, "legendary": false}, {"id": "pkmn-176", "name": "토게틱", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/176.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 176번 · 타입 페어리/비행 · HP 55 / 공격 40 / 방어 85 / 특공 80 / 특방 105 / 스피드 40", "types": ["페어리", "비행"], "moves": ["천사의키스", "치근거리기", "매지컬샤인", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-177", "name": "네이티", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/177.png", "weight": 33, "catchRate": 50, "power": 320, "trait": "도감 177번 · 타입 에스퍼/비행 · HP 40 / 공격 50 / 방어 45 / 특공 70 / 특방 45 / 스피드 70", "types": ["에스퍼", "비행"], "moves": ["염동력", "사이코키네시스", "환상빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-178", "evolveCount": 16, "legendary": false}, {"id": "pkmn-178", "name": "네이티오", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/178.png", "weight": 21, "catchRate": 50, "power": 470, "trait": "도감 178번 · 타입 에스퍼/비행 · HP 65 / 공격 75 / 방어 70 / 특공 95 / 특방 70 / 스피드 95", "types": ["에스퍼", "비행"], "moves": ["염동력", "사이코키네시스", "환상빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-179", "name": "메리프", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/179.png", "weight": 37, "catchRate": 50, "power": 280, "trait": "도감 179번 · 타입 전기 · HP 55 / 공격 40 / 방어 40 / 특공 65 / 특방 45 / 스피드 35", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-180", "evolveCount": 16, "legendary": false}, {"id": "pkmn-180", "name": "보송송", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/180.png", "weight": 30, "catchRate": 50, "power": 365, "trait": "도감 180번 · 타입 전기 · HP 70 / 공격 55 / 방어 55 / 특공 80 / 특방 60 / 스피드 45", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-181", "evolveCount": 32, "legendary": false}, {"id": "pkmn-181", "name": "전룡", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/181.png", "weight": 18, "catchRate": 50, "power": 510, "trait": "도감 181번 · 타입 전기 · HP 90 / 공격 75 / 방어 85 / 특공 115 / 특방 90 / 스피드 55", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-182", "name": "아르코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/182.png", "weight": 19, "catchRate": 50, "power": 490, "trait": "도감 182번 · 타입 풀 · HP 75 / 공격 80 / 방어 95 / 특공 90 / 특방 100 / 스피드 50", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-183", "name": "마릴", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/183.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 183번 · 타입 물/페어리 · HP 70 / 공격 20 / 방어 50 / 특공 20 / 특방 50 / 스피드 40", "types": ["물", "페어리"], "moves": ["물대포", "파도타기", "하이드로펌프", "천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "pkmn-184", "evolveCount": 32, "legendary": false}, {"id": "pkmn-184", "name": "마릴리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/184.png", "weight": 25, "catchRate": 50, "power": 420, "trait": "도감 184번 · 타입 물/페어리 · HP 100 / 공격 50 / 방어 80 / 특공 60 / 특방 80 / 스피드 50", "types": ["물", "페어리"], "moves": ["물대포", "파도타기", "하이드로펌프", "천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-185", "name": "꼬지모", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/185.png", "weight": 26, "catchRate": 50, "power": 410, "trait": "도감 185번 · 타입 바위 · HP 70 / 공격 100 / 방어 115 / 특공 30 / 특방 65 / 스피드 30", "types": ["바위"], "moves": ["돌떨구기", "스톤샤워", "원시의힘"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-186", "name": "왕구리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/186.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 186번 · 타입 물 · HP 90 / 공격 75 / 방어 75 / 특공 90 / 특방 100 / 스피드 70", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-187", "name": "통통코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/187.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 187번 · 타입 풀/비행 · HP 35 / 공격 35 / 방어 40 / 특공 35 / 특방 55 / 스피드 50", "types": ["풀", "비행"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-188", "evolveCount": 16, "legendary": false}, {"id": "pkmn-188", "name": "두코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/188.png", "weight": 32, "catchRate": 50, "power": 340, "trait": "도감 188번 · 타입 풀/비행 · HP 55 / 공격 45 / 방어 50 / 특공 45 / 특방 65 / 스피드 80", "types": ["풀", "비행"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "pkmn-189", "evolveCount": 32, "legendary": false}, {"id": "pkmn-189", "name": "솜솜코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/189.png", "weight": 22, "catchRate": 50, "power": 460, "trait": "도감 189번 · 타입 풀/비행 · HP 75 / 공격 55 / 방어 70 / 특공 55 / 특방 95 / 스피드 110", "types": ["풀", "비행"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-190", "name": "에이팜", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/190.png", "weight": 30, "catchRate": 50, "power": 360, "trait": "도감 190번 · 타입 노말 · HP 55 / 공격 70 / 방어 55 / 특공 40 / 특방 55 / 스피드 85", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-191", "name": "해너츠", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/191.png", "weight": 45, "catchRate": 50, "power": 180, "trait": "도감 191번 · 타입 풀 · HP 30 / 공격 30 / 방어 30 / 특공 30 / 특방 30 / 스피드 30", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "pkmn-192", "evolveCount": 16, "legendary": false}, {"id": "pkmn-192", "name": "해루미", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/192.png", "weight": 25, "catchRate": 50, "power": 425, "trait": "도감 192번 · 타입 풀 · HP 75 / 공격 75 / 방어 55 / 특공 105 / 특방 85 / 스피드 30", "types": ["풀"], "moves": ["덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-193", "name": "왕자리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/193.png", "weight": 28, "catchRate": 50, "power": 390, "trait": "도감 193번 · 타입 벌레/비행 · HP 65 / 공격 65 / 방어 45 / 특공 75 / 특방 45 / 스피드 95", "types": ["벌레", "비행"], "moves": ["더블니들", "연속자르기", "메가혼", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-194", "name": "우파", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/194.png", "weight": 42, "catchRate": 50, "power": 210, "trait": "도감 194번 · 타입 물/땅 · HP 55 / 공격 45 / 방어 45 / 특공 25 / 특방 25 / 스피드 15", "types": ["물", "땅"], "moves": ["물대포", "파도타기", "하이드로펌프", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-195", "evolveCount": 16, "legendary": false}, {"id": "pkmn-195", "name": "누오", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/195.png", "weight": 24, "catchRate": 50, "power": 430, "trait": "도감 195번 · 타입 물/땅 · HP 95 / 공격 85 / 방어 85 / 특공 65 / 특방 65 / 스피드 35", "types": ["물", "땅"], "moves": ["물대포", "파도타기", "하이드로펌프", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-196", "name": "에브이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/196.png", "weight": 16, "catchRate": 50, "power": 525, "trait": "도감 196번 · 타입 에스퍼 · HP 65 / 공격 65 / 방어 60 / 특공 130 / 특방 95 / 스피드 110", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-197", "name": "블래키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/197.png", "weight": 16, "catchRate": 50, "power": 525, "trait": "도감 197번 · 타입 악 · HP 95 / 공격 65 / 방어 110 / 특공 60 / 특방 130 / 스피드 65", "types": ["악"], "moves": ["물기", "깨물어부수기", "속여때리기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-198", "name": "니로우", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/198.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 198번 · 타입 악/비행 · HP 60 / 공격 85 / 방어 42 / 특공 85 / 특방 42 / 스피드 91", "types": ["악", "비행"], "moves": ["물기", "깨물어부수기", "속여때리기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-199", "name": "야도킹", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/199.png", "weight": 19, "catchRate": 50, "power": 490, "trait": "도감 199번 · 타입 물/에스퍼 · HP 95 / 공격 75 / 방어 80 / 특공 100 / 특방 110 / 스피드 30", "types": ["물", "에스퍼"], "moves": ["물대포", "파도타기", "하이드로펌프", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-200", "name": "무우마", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/200.png", "weight": 24, "catchRate": 50, "power": 435, "trait": "도감 200번 · 타입 고스트 · HP 60 / 공격 60 / 방어 60 / 특공 85 / 특방 85 / 스피드 85", "types": ["고스트"], "moves": ["핥기", "나이트헤드", "섀도볼"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-201", "name": "안농", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/201.png", "weight": 32, "catchRate": 50, "power": 336, "trait": "도감 201번 · 타입 에스퍼 · HP 48 / 공격 72 / 방어 48 / 특공 72 / 특방 48 / 스피드 48", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-202", "name": "마자용", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/202.png", "weight": 26, "catchRate": 50, "power": 405, "trait": "도감 202번 · 타입 에스퍼 · HP 190 / 공격 33 / 방어 58 / 특공 33 / 특방 58 / 스피드 33", "types": ["에스퍼"], "moves": ["염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-203", "name": "키링키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/203.png", "weight": 22, "catchRate": 50, "power": 455, "trait": "도감 203번 · 타입 노말/에스퍼 · HP 70 / 공격 80 / 방어 65 / 특공 90 / 특방 65 / 스피드 85", "types": ["노말", "에스퍼"], "moves": ["몸통박치기", "누르기", "하이퍼빔", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-204", "name": "피콘", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/204.png", "weight": 36, "catchRate": 50, "power": 290, "trait": "도감 204번 · 타입 벌레 · HP 50 / 공격 65 / 방어 90 / 특공 35 / 특방 35 / 스피드 15", "types": ["벌레"], "moves": ["더블니들", "연속자르기", "메가혼"], "evolvesTo": "pkmn-205", "evolveCount": 16, "legendary": false}, {"id": "pkmn-205", "name": "쏘콘", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/205.png", "weight": 21, "catchRate": 50, "power": 465, "trait": "도감 205번 · 타입 벌레/강철 · HP 75 / 공격 90 / 방어 140 / 특공 60 / 특방 60 / 스피드 40", "types": ["벌레", "강철"], "moves": ["더블니들", "연속자르기", "메가혼", "메탈크로우", "강철날개", "아이언테일"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-206", "name": "노고치", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/206.png", "weight": 25, "catchRate": 50, "power": 415, "trait": "도감 206번 · 타입 노말 · HP 100 / 공격 70 / 방어 70 / 특공 65 / 특방 65 / 스피드 45", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-207", "name": "글라이거", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/207.png", "weight": 24, "catchRate": 50, "power": 430, "trait": "도감 207번 · 타입 땅/비행 · HP 65 / 공격 75 / 방어 105 / 특공 35 / 특방 65 / 스피드 85", "types": ["땅", "비행"], "moves": ["구멍파기", "지진", "땅가르기", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-208", "name": "강철톤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/208.png", "weight": 18, "catchRate": 50, "power": 510, "trait": "도감 208번 · 타입 강철/땅 · HP 75 / 공격 85 / 방어 200 / 특공 55 / 특방 65 / 스피드 30", "types": ["강철", "땅"], "moves": ["메탈크로우", "강철날개", "아이언테일", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-209", "name": "블루", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/209.png", "weight": 35, "catchRate": 50, "power": 300, "trait": "도감 209번 · 타입 페어리 · HP 60 / 공격 80 / 방어 50 / 특공 40 / 특방 40 / 스피드 30", "types": ["페어리"], "moves": ["천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "pkmn-210", "evolveCount": 16, "legendary": false}, {"id": "pkmn-210", "name": "그랑블루", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/210.png", "weight": 22, "catchRate": 50, "power": 450, "trait": "도감 210번 · 타입 페어리 · HP 90 / 공격 120 / 방어 75 / 특공 60 / 특방 60 / 스피드 45", "types": ["페어리"], "moves": ["천사의키스", "치근거리기", "매지컬샤인"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-211", "name": "침바루", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/211.png", "weight": 23, "catchRate": 50, "power": 440, "trait": "도감 211번 · 타입 물/독 · HP 65 / 공격 95 / 방어 85 / 특공 55 / 특방 55 / 스피드 85", "types": ["물", "독"], "moves": ["물대포", "파도타기", "하이드로펌프", "독침", "오물공격", "독찌르기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-212", "name": "핫삼", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/212.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 212번 · 타입 벌레/강철 · HP 70 / 공격 130 / 방어 100 / 특공 55 / 특방 80 / 스피드 65", "types": ["벌레", "강철"], "moves": ["더블니들", "연속자르기", "메가혼", "메탈크로우", "강철날개", "아이언테일"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-213", "name": "단단지", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/213.png", "weight": 18, "catchRate": 50, "power": 505, "trait": "도감 213번 · 타입 벌레/바위 · HP 20 / 공격 10 / 방어 230 / 특공 10 / 특방 230 / 스피드 5", "types": ["벌레", "바위"], "moves": ["더블니들", "연속자르기", "메가혼", "돌떨구기", "스톤샤워", "원시의힘"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-214", "name": "헤라크로스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/214.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 214번 · 타입 벌레/격투 · HP 80 / 공격 125 / 방어 75 / 특공 40 / 특방 95 / 스피드 85", "types": ["벌레", "격투"], "moves": ["더블니들", "연속자르기", "메가혼", "태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-215", "name": "포푸니", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/215.png", "weight": 24, "catchRate": 50, "power": 430, "trait": "도감 215번 · 타입 악/얼음 · HP 55 / 공격 95 / 방어 55 / 특공 35 / 특방 75 / 스피드 115", "types": ["악", "얼음"], "moves": ["물기", "깨물어부수기", "속여때리기", "얼음뭉치", "얼음빔", "눈보라"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-216", "name": "깜지곰", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/216.png", "weight": 32, "catchRate": 50, "power": 330, "trait": "도감 216번 · 타입 노말 · HP 60 / 공격 80 / 방어 50 / 특공 50 / 특방 50 / 스피드 40", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "pkmn-217", "evolveCount": 16, "legendary": false}, {"id": "pkmn-217", "name": "링곰", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/217.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 217번 · 타입 노말 · HP 90 / 공격 130 / 방어 75 / 특공 75 / 특방 75 / 스피드 55", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-218", "name": "마그마그", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/218.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 218번 · 타입 불꽃 · HP 40 / 공격 40 / 방어 40 / 특공 70 / 특방 40 / 스피드 20", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-219", "evolveCount": 16, "legendary": false}, {"id": "pkmn-219", "name": "마그카르고", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/219.png", "weight": 24, "catchRate": 50, "power": 430, "trait": "도감 219번 · 타입 불꽃/바위 · HP 60 / 공격 50 / 방어 120 / 특공 90 / 특방 80 / 스피드 30", "types": ["불꽃", "바위"], "moves": ["불꽃세례", "화염방사", "불대문자", "돌떨구기", "스톤샤워", "원시의힘"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-220", "name": "꾸꾸리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/220.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 220번 · 타입 얼음/땅 · HP 50 / 공격 50 / 방어 40 / 특공 30 / 특방 30 / 스피드 50", "types": ["얼음", "땅"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-221", "evolveCount": 16, "legendary": false}, {"id": "pkmn-221", "name": "메꾸리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/221.png", "weight": 22, "catchRate": 50, "power": 450, "trait": "도감 221번 · 타입 얼음/땅 · HP 100 / 공격 100 / 방어 80 / 특공 60 / 특방 60 / 스피드 50", "types": ["얼음", "땅"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-222", "name": "코산호", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/222.png", "weight": 26, "catchRate": 50, "power": 410, "trait": "도감 222번 · 타입 물/바위 · HP 65 / 공격 55 / 방어 95 / 특공 65 / 특방 95 / 스피드 35", "types": ["물", "바위"], "moves": ["물대포", "파도타기", "하이드로펌프", "돌떨구기", "스톤샤워", "원시의힘"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-223", "name": "총어", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/223.png", "weight": 35, "catchRate": 50, "power": 300, "trait": "도감 223번 · 타입 물 · HP 35 / 공격 65 / 방어 35 / 특공 65 / 특방 35 / 스피드 65", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "pkmn-224", "evolveCount": 16, "legendary": false}, {"id": "pkmn-224", "name": "대포무노", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/224.png", "weight": 20, "catchRate": 50, "power": 480, "trait": "도감 224번 · 타입 물 · HP 75 / 공격 105 / 방어 75 / 특공 105 / 특방 75 / 스피드 45", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-225", "name": "딜리버드", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/225.png", "weight": 32, "catchRate": 50, "power": 330, "trait": "도감 225번 · 타입 얼음/비행 · HP 45 / 공격 55 / 방어 45 / 특공 65 / 특방 45 / 스피드 75", "types": ["얼음", "비행"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-226", "name": "만타인", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/226.png", "weight": 20, "catchRate": 50, "power": 485, "trait": "도감 226번 · 타입 물/비행 · HP 85 / 공격 40 / 방어 70 / 특공 80 / 특방 140 / 스피드 70", "types": ["물", "비행"], "moves": ["물대포", "파도타기", "하이드로펌프", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-227", "name": "무장조", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/227.png", "weight": 21, "catchRate": 50, "power": 465, "trait": "도감 227번 · 타입 강철/비행 · HP 65 / 공격 80 / 방어 140 / 특공 40 / 특방 70 / 스피드 70", "types": ["강철", "비행"], "moves": ["메탈크로우", "강철날개", "아이언테일", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-228", "name": "델빌", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/228.png", "weight": 32, "catchRate": 50, "power": 330, "trait": "도감 228번 · 타입 악/불꽃 · HP 45 / 공격 60 / 방어 30 / 특공 80 / 특방 50 / 스피드 65", "types": ["악", "불꽃"], "moves": ["물기", "깨물어부수기", "속여때리기", "불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-229", "evolveCount": 16, "legendary": false}, {"id": "pkmn-229", "name": "헬가", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/229.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 229번 · 타입 악/불꽃 · HP 75 / 공격 90 / 방어 50 / 특공 110 / 특방 80 / 스피드 95", "types": ["악", "불꽃"], "moves": ["물기", "깨물어부수기", "속여때리기", "불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-230", "name": "킹드라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/230.png", "weight": 15, "catchRate": 50, "power": 540, "trait": "도감 230번 · 타입 물/드래곤 · HP 75 / 공격 95 / 방어 95 / 특공 95 / 특방 95 / 스피드 85", "types": ["물", "드래곤"], "moves": ["물대포", "파도타기", "하이드로펌프", "용의숨결", "용의파동", "역린"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-231", "name": "코코리", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/231.png", "weight": 32, "catchRate": 50, "power": 330, "trait": "도감 231번 · 타입 땅 · HP 90 / 공격 60 / 방어 60 / 특공 40 / 특방 40 / 스피드 40", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-232", "evolveCount": 16, "legendary": false}, {"id": "pkmn-232", "name": "코리갑", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/232.png", "weight": 18, "catchRate": 50, "power": 500, "trait": "도감 232번 · 타입 땅 · HP 90 / 공격 120 / 방어 120 / 특공 60 / 특방 60 / 스피드 50", "types": ["땅"], "moves": ["구멍파기", "지진", "땅가르기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-233", "name": "폴리곤2", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/233.png", "weight": 17, "catchRate": 50, "power": 515, "trait": "도감 233번 · 타입 노말 · HP 85 / 공격 80 / 방어 90 / 특공 105 / 특방 95 / 스피드 60", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-234", "name": "노라키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/234.png", "weight": 21, "catchRate": 50, "power": 465, "trait": "도감 234번 · 타입 노말 · HP 73 / 공격 95 / 방어 62 / 특공 85 / 특방 65 / 스피드 85", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-235", "name": "루브도", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/235.png", "weight": 39, "catchRate": 50, "power": 250, "trait": "도감 235번 · 타입 노말 · HP 55 / 공격 20 / 방어 35 / 특공 20 / 특방 45 / 스피드 75", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-236", "name": "배루키", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/236.png", "weight": 42, "catchRate": 50, "power": 210, "trait": "도감 236번 · 타입 격투 · HP 35 / 공격 35 / 방어 35 / 특공 35 / 특방 35 / 스피드 35", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "pkmn-237", "evolveCount": 10, "legendary": false}, {"id": "pkmn-237", "name": "카포에라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/237.png", "weight": 22, "catchRate": 50, "power": 455, "trait": "도감 237번 · 타입 격투 · HP 50 / 공격 95 / 방어 95 / 특공 35 / 특방 110 / 스피드 70", "types": ["격투"], "moves": ["태권당수", "지옥의바퀴", "괴력"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-238", "name": "뽀뽀라", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/238.png", "weight": 35, "catchRate": 50, "power": 305, "trait": "도감 238번 · 타입 얼음/에스퍼 · HP 45 / 공격 30 / 방어 15 / 특공 85 / 특방 65 / 스피드 65", "types": ["얼음", "에스퍼"], "moves": ["얼음뭉치", "얼음빔", "눈보라", "염동력", "사이코키네시스", "환상빔"], "evolvesTo": "pkmn-124", "evolveCount": 10, "legendary": false}, {"id": "pkmn-239", "name": "에레키드", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/239.png", "weight": 30, "catchRate": 50, "power": 360, "trait": "도감 239번 · 타입 전기 · HP 45 / 공격 63 / 방어 37 / 특공 65 / 특방 55 / 스피드 95", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "pkmn-125", "evolveCount": 10, "legendary": false}, {"id": "pkmn-240", "name": "마그비", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/240.png", "weight": 30, "catchRate": 50, "power": 365, "trait": "도감 240번 · 타입 불꽃 · HP 45 / 공격 75 / 방어 37 / 특공 70 / 특방 55 / 스피드 83", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "pkmn-126", "evolveCount": 10, "legendary": false}, {"id": "pkmn-241", "name": "밀탱크", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/241.png", "weight": 19, "catchRate": 50, "power": 490, "trait": "도감 241번 · 타입 노말 · HP 95 / 공격 80 / 방어 105 / 특공 40 / 특방 70 / 스피드 100", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 16, "legendary": false}, {"id": "pkmn-242", "name": "해피너스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/242.png", "weight": 15, "catchRate": 50, "power": 540, "trait": "도감 242번 · 타입 노말 · HP 255 / 공격 10 / 방어 10 / 특공 75 / 특방 135 / 스피드 55", "types": ["노말"], "moves": ["몸통박치기", "누르기", "하이퍼빔"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-243", "name": "라이코", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/243.png", "weight": 3, "catchRate": 40, "power": 580, "trait": "도감 243번 · 타입 전기 · HP 90 / 공격 85 / 방어 75 / 특공 115 / 특방 100 / 스피드 115", "types": ["전기"], "moves": ["전기쇼크", "10만볼트", "번개"], "evolvesTo": "", "evolveCount": 16, "legendary": true}, {"id": "pkmn-244", "name": "앤테이", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/244.png", "weight": 3, "catchRate": 40, "power": 580, "trait": "도감 244번 · 타입 불꽃 · HP 115 / 공격 115 / 방어 85 / 특공 90 / 특방 75 / 스피드 100", "types": ["불꽃"], "moves": ["불꽃세례", "화염방사", "불대문자"], "evolvesTo": "", "evolveCount": 16, "legendary": true}, {"id": "pkmn-245", "name": "스이쿤", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/245.png", "weight": 3, "catchRate": 40, "power": 580, "trait": "도감 245번 · 타입 물 · HP 100 / 공격 75 / 방어 115 / 특공 90 / 특방 115 / 스피드 85", "types": ["물"], "moves": ["물대포", "파도타기", "하이드로펌프"], "evolvesTo": "", "evolveCount": 16, "legendary": true}, {"id": "pkmn-246", "name": "애버라스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/246.png", "weight": 35, "catchRate": 50, "power": 300, "trait": "도감 246번 · 타입 바위/땅 · HP 50 / 공격 64 / 방어 50 / 특공 45 / 특방 50 / 스피드 41", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "원시의힘", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-247", "evolveCount": 16, "legendary": false}, {"id": "pkmn-247", "name": "데기라스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/247.png", "weight": 26, "catchRate": 50, "power": 410, "trait": "도감 247번 · 타입 바위/땅 · HP 70 / 공격 84 / 방어 70 / 특공 65 / 특방 70 / 스피드 51", "types": ["바위", "땅"], "moves": ["돌떨구기", "스톤샤워", "원시의힘", "구멍파기", "지진", "땅가르기"], "evolvesTo": "pkmn-248", "evolveCount": 32, "legendary": false}, {"id": "pkmn-248", "name": "마기라스", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/248.png", "weight": 10, "catchRate": 50, "power": 600, "trait": "도감 248번 · 타입 바위/악 · HP 100 / 공격 134 / 방어 110 / 특공 95 / 특방 100 / 스피드 61", "types": ["바위", "악"], "moves": ["돌떨구기", "스톤샤워", "원시의힘", "물기", "깨물어부수기", "속여때리기"], "evolvesTo": "", "evolveCount": 32, "legendary": false}, {"id": "pkmn-249", "name": "루기아", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/249.png", "weight": 3, "catchRate": 40, "power": 680, "trait": "도감 249번 · 타입 에스퍼/비행 · HP 106 / 공격 90 / 방어 130 / 특공 90 / 특방 154 / 스피드 110", "types": ["에스퍼", "비행"], "moves": ["염동력", "사이코키네시스", "환상빔", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": true}, {"id": "pkmn-250", "name": "칠색조", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/250.png", "weight": 3, "catchRate": 40, "power": 680, "trait": "도감 250번 · 타입 불꽃/비행 · HP 106 / 공격 130 / 방어 90 / 특공 110 / 특방 154 / 스피드 90", "types": ["불꽃", "비행"], "moves": ["불꽃세례", "화염방사", "불대문자", "날개치기", "회전부리", "공중날기"], "evolvesTo": "", "evolveCount": 16, "legendary": true}, {"id": "pkmn-251", "name": "세레비", "image": "https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/251.png", "weight": 3, "catchRate": 40, "power": 600, "trait": "도감 251번 · 타입 에스퍼/풀 · HP 100 / 공격 100 / 방어 100 / 특공 100 / 특방 100 / 스피드 100", "types": ["에스퍼", "풀"], "moves": ["염동력", "사이코키네시스", "환상빔", "덩굴채찍", "잎날가르기", "솔라빔"], "evolvesTo": "", "evolveCount": 16, "legendary": true}];

const pid = (n) => 'pkmn-' + String(n).padStart(3, '0');
// 🌙 낮/밤에만 나오는 몬스터 (한국 시간 06~18시 = 낮)
const NIGHT_ONLY = new Set([92, 93, 94, 163, 164, 197, 198, 200, 215, 228, 229].map(pid));
const DAY_ONLY = new Set([165, 166, 187, 188, 189, 191, 192, 196].map(pid));
// 🎣 이벤트 때만 나오는 2세대 전설 (라이코·앤테이·스이쿤·루기아·칠색조·세레비)
const EVENT_ONLY = new Set([243, 244, 245, 249, 250, 251].map(pid));
// 💞 친밀도가 가득 차면 진화 (이브이는 낮이면 에브이, 밤이면 블래키)
const FRIEND_EVO = { 'pkmn-172': 'pkmn-025', 'pkmn-173': 'pkmn-035', 'pkmn-174': 'pkmn-039', 'pkmn-175': 'pkmn-176', 'pkmn-042': 'pkmn-169', 'pkmn-113': 'pkmn-242', 'pkmn-133': 'eevee' };
// 🔁 교환하면 바로 진화
const TRADE_EVO = { 'pkmn-064': 'pkmn-065', 'pkmn-067': 'pkmn-068', 'pkmn-075': 'pkmn-076', 'pkmn-093': 'pkmn-094', 'pkmn-095': 'pkmn-208', 'pkmn-123': 'pkmn-212', 'pkmn-117': 'pkmn-230', 'pkmn-137': 'pkmn-233', 'pkmn-061': 'pkmn-186', 'pkmn-079': 'pkmn-199' };
// 1세대 → 2세대로 이어지는 진화 (DJ 목록에 진화 대상이 비어 있을 때만 채워요)
const GEN1_LINK = { 'pkmn-042': 'pkmn-169', 'pkmn-095': 'pkmn-208', 'pkmn-113': 'pkmn-242', 'pkmn-117': 'pkmn-230', 'pkmn-123': 'pkmn-212', 'pkmn-137': 'pkmn-233' };
// 🥚 알에서 나오는 모습 (아기 포켓몬)
const BABY_OF = { 'pkmn-025': 'pkmn-172', 'pkmn-026': 'pkmn-172', 'pkmn-035': 'pkmn-173', 'pkmn-036': 'pkmn-173', 'pkmn-039': 'pkmn-174', 'pkmn-040': 'pkmn-174', 'pkmn-124': 'pkmn-238', 'pkmn-125': 'pkmn-239', 'pkmn-126': 'pkmn-240', 'pkmn-106': 'pkmn-236', 'pkmn-107': 'pkmn-236', 'pkmn-237': 'pkmn-236' };
const UNOWN = 'pkmn-201';
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ITEMS = [
  { id: 'band', name: '힘의머리띠', icon: '⚔️', desc: '대결·체육관·토너먼트 공격력 +15%' },
  { id: 'charm', name: '행운의부적', icon: '🍀', desc: '잡기 확률 +10%p (각자 확률판정 방식)' },
  { id: 'egg', name: '부화의돌', icon: '🥚', desc: '알이 2배 빨리 부화' },
];
const REWARD_KEYS = ['gym', 'tourney', 'dexGen1', 'dexGen2', 'shinyDex', 'unown'];
const REWARD_LABEL = { gym: '🏟️ 배지 8개', tourney: '🏆 토너먼트 우승', dexGen1: '📜 1세대 도감 완성', dexGen2: '📜 2세대 도감 완성', shinyDex: '🌈 이로치 도감 완성', unown: '🔤 안농 26종' };
const TITLE = { gym: '🏅 성도 챔피언', tourney: '🏆 토너먼트 우승자', dexGen1: '📕 관동 도감 마스터', dexGen2: '📗 성도 도감 마스터', shinyDex: '🌈 이로치 마스터', unown: '🔤 안농 박사' };
const DEFAULT_GYMS = [
  { name: '비상체육관 · 도라지', monsterId: 'pkmn-018', power: 300 },
  { name: '고동체육관 · 호일', monsterId: 'pkmn-212', power: 380 },
  { name: '금빛체육관 · 꼭두', monsterId: 'pkmn-241', power: 450 },
  { name: '인주체육관 · 유빈', monsterId: 'pkmn-094', power: 510 },
  { name: '진청체육관 · 사도', monsterId: 'pkmn-068', power: 570 },
  { name: '담청체육관 · 규리', monsterId: 'pkmn-208', power: 630 },
  { name: '황토체육관 · 류옹', monsterId: 'pkmn-087', power: 690 },
  { name: '검은먹체육관 · 이향', monsterId: 'pkmn-230', power: 760 },
];
const DEFAULT_CFG = {
  follow: true,          // 🐾 따라다니기 (대표 몬스터가 방송에 처음 채팅할 때 인사 · 6시간에 한 번)
  eggChats: 30,          // 🥚 알 부화에 필요한 채팅 수
  eggShiny: 15,          // 🥚 알에서 이로치가 나올 확률(%)
  eggMax: 3,             // 🥚 한 사람이 가질 수 있는 알 수
  friendNeed: 100,       // 💞 친밀도 진화에 필요한 친밀도
  gymCooldownSec: 60,    // 🏟️ 체육관 도전 쿨타임
  eventMin: 10,          // 🎣 이벤트 기본 시간(분)
  tourneyJoinSec: 60,    // 🏆 토너먼트 참가 받는 시간(초)
  auctionSec: 60,        // 🏪 경매 시간(초)
  itemPrice: { band: 120, charm: 100, egg: 60 }, // 🎁 아이템 가격(포인트)
  gyms: DEFAULT_GYMS,
  rewards: { gym: { kind: 'points', amount: 300, roulette: 1 }, tourney: { kind: 'points', amount: 200, roulette: 1 }, dexGen1: { kind: 'balls', amount: 50, roulette: 1 }, dexGen2: { kind: 'balls', amount: 50, roulette: 1 }, shinyDex: { kind: 'points', amount: 1000, roulette: 1 }, unown: { kind: 'balls', amount: 30, roulette: 1 } },
};
const clampInt = (v, lo, hi, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
const kstHour = () => new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
const isDay = () => { const h = kstHour(); return h >= 6 && h < 18; };

module.exports = function createMonster2(A) {
  // A = monster.js 가 넘겨주는 것들
  const { store, isModuleOn, getRoom, sendChatToRoom, sendChatSplit, getActivitySettings, findActUserKey, resolveNicknameFromInput } = A;
  const say = (dj, m, delay) => setTimeout(() => sendChatToRoom(dj, m), delay == null ? 400 : delay);
  const sayLong = (dj, m) => sendChatSplit(dj, m, 150, 500);

  // ───── 설정 ─────
  function cfgOf(mc) {
    if (!mc.g2 || typeof mc.g2 !== 'object') mc.g2 = {};
    const g = mc.g2;
    for (const k of Object.keys(DEFAULT_CFG)) if (g[k] === undefined) g[k] = JSON.parse(JSON.stringify(DEFAULT_CFG[k]));
    if (!g.rewards || typeof g.rewards !== 'object') g.rewards = {};
    for (const k of REWARD_KEYS) if (!g.rewards[k]) g.rewards[k] = { ...DEFAULT_CFG.rewards[k] };
    if (!g.itemPrice || typeof g.itemPrice !== 'object') g.itemPrice = { ...DEFAULT_CFG.itemPrice };
    if (!Array.isArray(g.gyms) || !g.gyms.length) g.gyms = JSON.parse(JSON.stringify(DEFAULT_GYMS));
    return g;
  }
  function sanitize(b, cur) {
    const c = JSON.parse(JSON.stringify(cur || {})); b = b || {};
    if (b.follow != null) c.follow = !!b.follow;
    if (b.eggChats != null) c.eggChats = clampInt(b.eggChats, 1, 9999, 30);
    if (b.eggShiny != null) c.eggShiny = clampInt(b.eggShiny, 0, 100, 15);
    if (b.eggMax != null) c.eggMax = clampInt(b.eggMax, 1, 10, 3);
    if (b.friendNeed != null) c.friendNeed = clampInt(b.friendNeed, 1, 9999, 100);
    if (b.gymCooldownSec != null) c.gymCooldownSec = clampInt(b.gymCooldownSec, 0, 3600, 60);
    if (b.eventMin != null) c.eventMin = clampInt(b.eventMin, 1, 180, 10);
    if (b.tourneyJoinSec != null) c.tourneyJoinSec = clampInt(b.tourneyJoinSec, 15, 600, 60);
    if (b.auctionSec != null) c.auctionSec = clampInt(b.auctionSec, 15, 600, 60);
    if (b.itemPrice && typeof b.itemPrice === 'object') { c.itemPrice = c.itemPrice || {}; for (const it of ITEMS) if (b.itemPrice[it.id] != null) c.itemPrice[it.id] = clampInt(b.itemPrice[it.id], 0, 999999, DEFAULT_CFG.itemPrice[it.id]); }
    if (Array.isArray(b.gyms) && b.gyms.length) c.gyms = b.gyms.slice(0, 8).map((g, i) => ({ name: String(g.name || '').trim().slice(0, 30) || DEFAULT_GYMS[i % 8].name, monsterId: String(g.monsterId || DEFAULT_GYMS[i % 8].monsterId), power: clampInt(g.power, 1, 99999, DEFAULT_GYMS[i % 8].power) }));
    if (b.rewards && typeof b.rewards === 'object') {
      c.rewards = c.rewards || {};
      for (const k of REWARD_KEYS) {
        const r = b.rewards[k]; if (!r) continue;
        c.rewards[k] = { kind: ['none', 'balls', 'greatballs', 'points', 'lotto', 'roulette'].includes(r.kind) ? r.kind : 'points', amount: clampInt(r.amount, 0, 999999, 0), roulette: clampInt(r.roulette, 1, 10, 1) };
      }
    }
    return c;
  }

  // ───── 2세대 자동 추가 (DJ 목록·통합 도감·거다이맥스 목록) ─────
  function addGen2To(list) {
    const have = new Set(list.map((m) => m && m.id));
    let n = 0;
    for (const m of GEN2) if (!have.has(m.id)) { list.push({ ...m, types: [...m.types], moves: [...m.moves] }); n++; }
    for (const m of list) if (m && GEN1_LINK[m.id] && !m.evolvesTo) m.evolvesTo = GEN1_LINK[m.id];
    return n;
  }
  function ensureGen2(djId, mc) {
    if (mc.gen2Added || !Array.isArray(mc.monsters)) return;
    mc.gen2Added = true;
    const n = addGen2To(mc.monsters);
    try { store.upsertMonsterCatalog(GEN2); } catch (_) {}
    try { A.mcSaveConfig(djId, mc); } catch (_) {}
    if (n) console.log(`[몬스터 2세대][${djId}] 2세대 ${n}마리 추가`);
  }
  function ensureGen2Global(gmc, adminId) {
    if (!gmc || gmc.gen2Added || !Array.isArray(gmc.monsters) || !gmc.monsters.length) return;
    gmc.gen2Added = true;
    addGen2To(gmc.monsters);
    try { store.saveSettings(adminId, { globalMonsterCatalog: gmc }); } catch (_) {}
  }
  function ensureGen2Gmax(gc, adminId) {
    if (!gc || gc.gen2Added) return;
    gc.gen2Added = true;
    const set = new Set(gc.eligibleIds || []);
    for (const m of GEN2) set.add(m.id);
    gc.eligibleIds = [...set];
    try { store.saveSettings(adminId, { gmaxConfig: gc }); } catch (_) {}
  }

  // ───── 공용 유저 데이터 (globalMonsterDex 의 새 칸 · PC 와 같이 맞춰져요) ─────
  function sec(name) { const d = A.loadGlobalMonsterDex(); if (!d[name] || typeof d[name] !== 'object') d[name] = {}; return d[name]; }
  const saveDex = () => A.saveGlobalMonsterDex();
  const web = () => A.mcGetWebData();
  const saveWeb = () => A.mcSaveWebData();
  const pointsOf = (key) => web().points[key] || 0;
  const addPoints = (key, n) => { const w = web(); w.points[key] = Math.max(0, (w.points[key] || 0) + n); saveWeb(); return w.points[key]; };
  const itemsOf = (key) => { const s = sec('g2items'); if (!s[key] || typeof s[key] !== 'object') s[key] = { owned: {}, held: '' }; if (!s[key].owned) s[key].owned = {}; return s[key]; };
  const heldOf = (key) => { const s = sec('g2items')[key]; return (s && s.held) || ''; };
  const powerMult = (key) => (heldOf(key) === 'band' ? 1.15 : 1);
  const catchBonus = (key) => (heldOf(key) === 'charm' ? 10 : 0);
  const awardsOf = (key) => { const s = sec('g2awards'); if (!s[key] || typeof s[key] !== 'object') s[key] = {}; return s[key]; };

  // ───── 이름으로 몬스터 찾기 ("이로치 " / "거다이맥스 " 붙이면 그 개체) ─────
  function findByName(mc, raw) {
    let name = String(raw || '').trim(), prefix = '';
    for (const [p, pre] of [['🌈이로치 ', A.MC_SHINY_PREFIX], ['이로치 ', A.MC_SHINY_PREFIX], ['🌟거다이맥스 ', A.MC_GMAX_PREFIX], ['거다이맥스 ', A.MC_GMAX_PREFIX]]) {
      if (name.startsWith(p)) { prefix = pre; name = name.slice(p.length).trim(); break; }
    }
    const mon = mc.monsters.find((m) => m.name === name);
    if (!mon) return null;
    return { mon, id: prefix + mon.id, prefix, label: (prefix === A.MC_SHINY_PREFIX ? '🌈이로치 ' : prefix === A.MC_GMAX_PREFIX ? '🌟거다이맥스 ' : '') + mon.name };
  }
  const baseOf = (id) => String(id).replace(/^(shiny_|gmax_)/, '');
  const prefixOf = (id) => (String(id).startsWith('shiny_') ? 'shiny_' : String(id).startsWith('gmax_') ? 'gmax_' : '');
  const labelOf = (mc, id) => { const r = A.mcResolveMonster(id, mc.monsters); return r ? r.name : id; };
  const owns = (mc, key, id) => (mc.collections[key] && mc.collections[key][id]) || 0;
  function give(mc, key, id, n) {
    if (!mc.collections[key]) mc.collections[key] = {};
    mc.collections[key][id] = (mc.collections[key][id] || 0) + (n || 1);
  }
  function take(mc, key, id, n) {
    const c = mc.collections[key]; if (!c || (c[id] || 0) < n) return false;
    c[id] -= n;
    if (c[id] <= 0) { c[id] = 0; const w = web(); if (w.selected[key] === id) { delete w.selected[key]; saveWeb(); } }
    return true;
  }
  // 대결용 (가장 강한 몬스터 + 지닌 물건)
  function fighter(mc, key) {
    const m = A.mcPickStrongest(mc.collections[key], mc.monsters, key);
    if (!m) return null;
    return { ...m, power: Math.round((Number(m.power) || 10) * powerMult(key)) };
  }
  function isStaff(djId, room, settings, author, authorId) {
    const isDj = authorId != null && room.liveDjUserId != null && authorId === room.liveDjUserId;
    if (isDj) return true;
    const act = getActivitySettings(djId, settings);
    return (act.grantNicknames || []).map((n) => String(n || '').trim().toLowerCase()).includes(String(author || '').trim().toLowerCase());
  }
  function nameOfTag(djId, settings, room, t) {
    const act = getActivitySettings(djId, settings);
    const e = Object.values(act.users || {}).find((u) => (u.tag || '').toLowerCase() === String(t).toLowerCase());
    return (e && e.nickname) || resolveNicknameFromInput(room, t) || t;
  }

  // ───── 🎁 보상 지급 (DJ 가 설정에서 고른 것) ─────
  function grantReward(djId, settings, mc, key, nick, which) {
    const r = (cfgOf(mc).rewards || {})[which];
    if (!r || r.kind === 'none' || !(r.amount > 0)) return '';
    const n = r.amount;
    if (r.kind === 'balls') { if (mc.bags[key] == null) mc.bags[key] = 0; mc.bags[key] += n; A.mcSaveUserData(); return `포획볼 ${n}개`; }
    if (r.kind === 'greatballs') { mc.greatBags[key] = (mc.greatBags[key] || 0) + n; A.mcSaveUserData(); return `고급몬스터볼 ${n}개`; }
    if (r.kind === 'points') { addPoints(key, n); return `포인트 ${n}`; }
    if (r.kind === 'lotto') {
      const act = getActivitySettings(djId, settings);
      const ak = findActUserKey(act, key) || findActUserKey(act, nick);
      if (!ak) { addPoints(key, n); return `포인트 ${n} (애청지수 등록이 안 돼 있어서 복권 대신)`; }
      act.users[ak].lotto = (act.users[ak].lotto || 0) + n;
      store.saveSettings(djId, { activity: act });
      return `복권 ${n}장`;
    }
    if (r.kind === 'roulette') {
      if (A.grantRoulette) { const lb = A.grantRoulette(djId, settings, key, nick, r.roulette || 1, n); if (lb) return lb; } // (비공식 에디냥)
      const R = A.roulette && A.roulette();
      try {
        const list = R && R.S(djId).list; const rt = list && list[(r.roulette || 1) - 1];
        const u = rt && (R.findUser ? R.findUser(key) : { handle: '@' + key, nick: nick }); // (PC 룰렛엔 findUser 가 없어요)
        if (rt && u) { const rec = R.rec(djId, u.handle, u.nick); rec.coupons[rt.id] = (rec.coupons[rt.id] || 0) + n; R.changed(djId, u.handle); return `룰렛${r.roulette}(${rt.name}) 룰렛권 ${n}장`; }
      } catch (_) {}
      addPoints(key, n); return `포인트 ${n} (룰렛권을 줄 수 없어서 대신)`;
    }
    return '';
  }
  function award(djId, settings, mc, key, nick, which) {
    const a = awardsOf(key);
    if (a[which]) return false;
    a[which] = Date.now(); saveDex();
    const got = grantReward(djId, settings, mc, key, nick, which);
    say(djId, `🎉 ${nick}님 ${REWARD_LABEL[which]} 달성! 칭호 [${TITLE[which]}] 획득${got ? ` · 보상 ${got}` : ''}`, 900);
    return true;
  }
  // 📜 도감 완성 확인 (잡을 때·알 부화·교환 뒤)
  function checkDex(djId, settings, mc, key, nick) {
    const c = mc.collections[key] || {};
    const has = (id) => (c[id] || 0) > 0 || Object.prototype.hasOwnProperty.call(c, id);
    const ids = new Set(mc.monsters.map((m) => m.id));
    const g1 = []; const g2 = [];
    for (let i = 1; i <= 151; i++) if (ids.has(pid(i))) g1.push(pid(i));
    for (let i = 152; i <= 251; i++) if (ids.has(pid(i))) g2.push(pid(i));
    if (g1.length >= 151 && g1.every(has)) award(djId, settings, mc, key, nick, 'dexGen1');
    if (g2.length >= 100 && g2.every(has)) award(djId, settings, mc, key, nick, 'dexGen2');
    const all = g1.concat(g2);
    if (all.length >= 251 && all.every((id) => has(A.MC_SHINY_PREFIX + id))) award(djId, settings, mc, key, nick, 'shinyDex');
  }

  // ───── 🌙 / 🎣 등장 몬스터 고르기 ─────
  function pickSpawn(djId, mc) {
    const room = getRoom(djId);
    const ev = room._g2event && room._g2event.until > Date.now() ? room._g2event : null;
    const day = isDay();
    const list = [];
    for (const m of mc.monsters || []) {
      if (!m || !m.name || !(Number(m.weight) > 0)) continue;
      if (NIGHT_ONLY.has(m.id) && day) continue;
      if (DAY_ONLY.has(m.id) && !day) continue;
      let w = Number(m.weight);
      const hit = ev && (ev.legend ? m.legendary : m.id === ev.id);
      if (EVENT_ONLY.has(m.id) && !hit) continue;
      if (hit) w = w * (ev.legend ? 5 : 10);
      list.push([m, w]);
    }
    if (!list.length) return null;
    let r = Math.random() * list.reduce((s, x) => s + x[1], 0);
    for (const [m, w] of list) { r -= w; if (r <= 0) return m; }
    return list[list.length - 1][0];
  }

  // ───── 잡은 뒤 (안농 글자 · 도감 완성) ─────
  function onCaught(djId, settings, mc, key, nick, grantId) {
    if (baseOf(grantId) === UNOWN) {
      const s = sec('g2unown'); const have = String(s[key] || '');
      const L = LETTERS[Math.floor(Math.random() * 26)];
      if (!have.includes(L)) {
        s[key] = (have + L).split('').sort().join(''); saveDex();
        say(djId, `🔤 ${nick}님이 안농 [${L}] 모양을 찾았어요! (${s[key].length}/26)`, 800);
        if (s[key].length >= 26) award(djId, settings, mc, key, nick, 'unown');
      } else say(djId, `🔤 ${nick}님의 안농은 [${L}] 모양이었어요 (이미 있는 글자 · ${have.length}/26)`, 800);
    }
    checkDex(djId, settings, mc, key, nick);
  }

  // ───── 💞 친밀도 ─────
  function friendTarget(mc, key) {
    const w = web(); const sel = w.selected[key];
    if (sel && owns(mc, key, sel) > 0) return sel;
    const m = A.mcPickStrongest(mc.collections[key], mc.monsters, key);
    if (!m) return null;
    const ids = Object.keys(mc.collections[key] || {}).filter((id) => owns(mc, key, id) > 0 && baseOf(id) === m.id);
    return ids[0] || null;
  }
  function addFriend(djId, settings, mc, key, nick, amount) {
    const id = friendTarget(mc, key); if (!id) return;
    const s = sec('g2friend'); if (!s[key] || typeof s[key] !== 'object') s[key] = {};
    s[key][id] = Math.min(9999, (s[key][id] || 0) + amount);
    const need = cfgOf(mc).friendNeed;
    let to = FRIEND_EVO[baseOf(id)];
    if (to && s[key][id] >= need) {
      if (to === 'eevee') to = isDay() ? 'pkmn-196' : 'pkmn-197';
      const target = mc.monsters.find((m) => m.id === to);
      if (target && take(mc, key, id, 1)) {
        const nid = prefixOf(id) + to;
        give(mc, key, nid, 1); s[key][id] = 0;
        const w = web(); if (!w.selected[key]) { w.selected[key] = nid; saveWeb(); }
        A.mcSaveUserData();
        say(djId, `💞 ${nick}님의 [${labelOf(mc, id)}]이(가) 친밀도가 가득 차서 [${labelOf(mc, nid)}](으)로 진화했어요!`, 700);
        checkDex(djId, settings, mc, key, nick);
      }
    }
    saveDex();
  }

  // ───── 🥚 알 ─────
  const PRE = {}; for (const m of GEN2) if (m.evolvesTo) PRE[m.evolvesTo] = m.id;
  function eggOf(mc, id) {
    let cur = baseOf(id);
    const pre = {}; for (const m of mc.monsters) if (m.evolvesTo) pre[m.evolvesTo] = pre[m.evolvesTo] || m.id;
    for (let i = 0; i < 5 && pre[cur]; i++) cur = pre[cur];
    return BABY_OF[cur] && mc.monsters.some((m) => m.id === BABY_OF[cur]) ? BABY_OF[cur] : cur;
  }
  function hatchTick(djId, settings, mc, key, nick) {
    const s = sec('g2eggs'); const eggs = s[key];
    if (!Array.isArray(eggs) || !eggs.length) return;
    const g = cfgOf(mc);
    eggs[0].steps = (eggs[0].steps || 0) + (heldOf(key) === 'egg' ? 2 : 1);
    if (eggs[0].steps >= (eggs[0].need || g.eggChats)) {
      const egg = eggs.shift();
      const shiny = Math.random() * 100 < (egg.shiny ? Math.min(100, g.eggShiny * 2) : g.eggShiny);
      const gid = (shiny ? A.MC_SHINY_PREFIX : '') + egg.id;
      give(mc, key, gid, 1); A.mcSaveUserData();
      say(djId, `🥚✨ ${nick}님의 알이 부화해서 [${labelOf(mc, gid)}]이(가) 태어났어요!${eggs.length ? ` (남은 알 ${eggs.length}개)` : ''}`, 600);
      onCaught(djId, settings, mc, key, nick, gid);
    }
    saveDex();
  }

  // ───── 방마다 (메모리) ─────
  const R = (djId) => { const r = getRoom(djId); if (!r._g2) r._g2 = { greet: new Map(), friendAt: new Map(), gymAt: new Map(), trade: null, tourney: null, auction: null }; return r._g2; };

  // ───── 채팅 명령어 ─────
  function onChat(djId, settings, room, author, tag, text, authorId, self) {
    if (!isModuleOn(settings, 'monstercatch', djId)) return;
    const mc = A.getMonsterCatchSettings(djId, settings);
    const g = cfgOf(mc);
    const key = String(tag || '').trim().toLowerCase();
    const msg = String(text || '').trim();
    const st = R(djId);
    const parts = msg.split(/\s+/);
    const head = parts[0];

    // 자동: 따라다니기 · 친밀도 · 알 부화 (명령어가 아닌 채팅만 · 모험 시작한 사람만)
    if (!self && key && mc.bags[key] != null) {
      if (g.follow) {
        const last = st.greet.get(key) || 0;
        const w = web(); const sel = w.selected[key];
        if (Date.now() - last > 6 * 3600 * 1000 && sel && owns(mc, key, sel) > 0) {
          st.greet.set(key, Date.now());
          say(djId, `🐾 ${author}님의 [${labelOf(mc, sel)}]이(가) 졸졸 따라와서 인사해요!`, 900);
        } else if (!last) st.greet.set(key, Date.now());
      }
      if (!msg.startsWith('!')) {
        const fa = st.friendAt.get(key) || 0;
        if (Date.now() - fa > 20000) { st.friendAt.set(key, Date.now()); addFriend(djId, settings, mc, key, author, 1); }
        hatchTick(djId, settings, mc, key, author);
      }
    }
    if (!msg.startsWith('!')) return;

    // 📖 도움말 (기존 도움말 다음에 이어서)
    if (msg === '!몬스터도움말' || msg === '!몬스터명령어') {
      setTimeout(() => sayLong(djId, [
        '🐾 몬스터 2세대 명령어',
        '!맡기기 [몬스터] — 같은 몬스터 2마리로 알 받기 · !알 — 알 확인 (채팅을 치면 부화)',
        '!친밀도 — 대표 몬스터 친밀도 (가득 차면 진화하는 몬스터도 있어요 · 이브이는 낮=에브이 밤=블래키)',
        '!교환 [고유닉] [내 몬스터] [상대 몬스터] → 상대가 !교환수락 (교환하면 진화하는 몬스터도 있어요)',
        '!체육관 · !도전 — 배지 8개 모으기 · !토너먼트참가 (DJ가 !토너먼트 로 열어요)',
        '!팔기 [몬스터] [수량] · !경매 [몬스터] [시작가] · !입찰 [포인트]',
        '!아이템 · !아이템구매 [이름] · !지니기 [이름] · !안농 · !트레이너',
        '🌙 밤에만 / ☀️ 낮에만 나오는 몬스터가 있고, DJ가 !이벤트 [몬스터|전설] [분] 으로 한정 출현을 열 수 있어요',
      ].join('\n')), 1600);
      return;
    }

    // 🎣 이벤트 (DJ·매니저)
    if (head === '!이벤트') {
      if (!isStaff(djId, room, settings, author, authorId)) return say(djId, '⚠️ DJ 또는 매니저만 열 수 있어요.');
      if (parts[1] === '끝' || parts[1] === '종료') { room._g2event = null; return say(djId, '🎣 한정 출현 이벤트를 끝냈어요.'); }
      const min = clampInt(parts[parts.length - 1], 1, 180, 0);
      const nameParts = min && parts.length > 2 ? parts.slice(1, -1) : parts.slice(1);
      const name = nameParts.join(' ');
      const dur = min || g.eventMin;
      if (!name) return say(djId, '⚠️ 사용법: !이벤트 [몬스터이름 또는 전설] [분] · 끝내기: !이벤트 끝');
      if (name === '전설') { room._g2event = { legend: true, until: Date.now() + dur * 60000 }; return say(djId, `🎣✨ ${dur}분 동안 전설 몬스터가 더 잘 나와요! (라이코·앤테이·스이쿤·루기아·칠색조·세레비도 이때만!)`); }
      const f = findByName(mc, name);
      if (!f) return say(djId, `⚠️ [${name}]은(는) 이 방 몬스터 목록에 없어요.`);
      room._g2event = { id: f.mon.id, until: Date.now() + dur * 60000 };
      return say(djId, `🎣 ${dur}분 동안 [${f.mon.name}]이(가) 10배 더 잘 나와요!`);
    }

    // 🏆 토너먼트 (DJ·매니저가 열기)
    if (head === '!토너먼트') {
      if (!isStaff(djId, room, settings, author, authorId)) return say(djId, '⚠️ DJ 또는 매니저만 열 수 있어요.');
      if (st.tourney) return say(djId, '⚠️ 이미 토너먼트 참가를 받고 있어요.');
      st.tourney = { players: new Map(), timer: setTimeout(() => runTourney(djId), g.tourneyJoinSec * 1000) };
      return say(djId, `🏆 몬스터 토너먼트 참가 접수! ${g.tourneyJoinSec}초 안에 !토너먼트참가 (대표 몬스터로 자동 대진 · 최대 16명)`);
    }
    if (head === '!토너먼트참가') {
      if (!key) return;
      if (!st.tourney) return say(djId, '⚠️ 지금은 토너먼트 참가를 받고 있지 않아요.');
      if (st.tourney.players.has(key)) return;
      if (st.tourney.players.size >= 16) return say(djId, '⚠️ 참가 인원이 가득 찼어요 (16명).');
      if (!fighter(mc, key)) return say(djId, `⚠️ ${author}님, 몬스터를 먼저 잡아야 참가할 수 있어요!`);
      st.tourney.players.set(key, author);
      return say(djId, `🏆 ${author}님 토너먼트 참가! (${st.tourney.players.size}명)`);
    }

    if (!key) return;
    const started = mc.bags[key] != null;
    const needStart = () => say(djId, `⚠️ ${author}님, 먼저 ${mc.cmdStart || '!모험시작'}으로 모험을 시작해주세요!`);

    // 🥚 알
    if (head === '!맡기기') {
      if (!started) return needStart();
      const f = findByName(mc, parts.slice(1).join(' '));
      if (!f) return say(djId, '⚠️ 사용법: !맡기기 [몬스터이름] (같은 몬스터 2마리가 필요해요)');
      if (f.mon.legendary || f.mon.id === UNOWN) return say(djId, '⚠️ 전설 몬스터와 안농은 알을 낳지 않아요.');
      const s = sec('g2eggs'); if (!Array.isArray(s[key])) s[key] = [];
      if (s[key].length >= g.eggMax) return say(djId, `⚠️ 알은 ${g.eggMax}개까지 가질 수 있어요! 채팅을 쳐서 먼저 부화시켜주세요.`);
      if (owns(mc, key, f.id) < 2) return say(djId, `⚠️ [${f.label}] 2마리가 필요해요! (지금 ${owns(mc, key, f.id)}마리)`);
      take(mc, key, f.id, 2); A.mcSaveUserData();
      const eid = eggOf(mc, f.mon.id);
      s[key].push({ id: eid, steps: 0, need: g.eggChats, shiny: f.prefix === A.MC_SHINY_PREFIX, at: Date.now() }); saveDex();
      return say(djId, `🥚 ${author}님이 [${f.label}] 2마리를 맡겨서 알을 받았어요! 채팅 ${g.eggChats}번이면 부화해요${f.prefix === A.MC_SHINY_PREFIX ? ' (이로치 부모라 이로치 확률 2배!)' : ''} (알 ${s[key].length}/${g.eggMax})`);
    }
    if (head === '!알') {
      const eggs = sec('g2eggs')[key] || [];
      if (!eggs.length) return say(djId, `🥚 ${author}님은 알이 없어요. !맡기기 [몬스터]로 같은 몬스터 2마리를 맡기면 알을 받아요.`);
      return say(djId, `🥚 ${author}님의 알\n` + eggs.map((e, i) => `${i + 1}. ${i === 0 ? '부화 중' : '대기'} ${e.steps || 0}/${e.need || g.eggChats}`).join('\n') + (heldOf(key) === 'egg' ? '\n(🥚 부화의돌 — 2배 빨리!)' : ''));
    }

    // 💞 친밀도
    if (head === '!친밀도') {
      const id = friendTarget(mc, key);
      if (!id) return say(djId, `💞 ${author}님은 아직 몬스터가 없어요.`);
      const v = (sec('g2friend')[key] || {})[id] || 0;
      const to = FRIEND_EVO[baseOf(id)];
      return say(djId, `💞 ${author}님의 [${labelOf(mc, id)}] 친밀도 ${Math.min(v, g.friendNeed)}/${g.friendNeed}${to ? ' · 가득 차면 진화해요!' : ''}\n(채팅 20초에 +1 · 대결·체육관·토너먼트 +3)`);
    }

    // 🔁 교환
    if (head === '!교환') {
      if (!started) return needStart();
      if (parts.length < 4) return say(djId, '⚠️ 사용법: !교환 [상대 고유닉] [내 몬스터] [상대 몬스터] (이름에 띄어쓰기가 있으면 "이로치 이름"처럼 앞에 붙여요)');
      const tKey = parts[1].replace(/^@/, '').toLowerCase();
      if (tKey === key) return say(djId, '⚠️ 본인과는 교환할 수 없어요.');
      // 이름 나누기: 남은 단어들 중 두 몬스터 이름을 찾기
      const rest = parts.slice(2);
      let mine = null, theirs = null;
      for (let i = 1; i < rest.length; i++) { const a = findByName(mc, rest.slice(0, i).join(' ')); const b = findByName(mc, rest.slice(i).join(' ')); if (a && b) { mine = a; theirs = b; break; } }
      if (!mine || !theirs) return say(djId, '⚠️ 몬스터 이름을 찾을 수 없어요.');
      if (owns(mc, key, mine.id) < 1) return say(djId, `⚠️ ${author}님은 [${mine.label}]이(가) 없어요.`);
      if (owns(mc, tKey, theirs.id) < 1) return say(djId, `⚠️ 상대(${parts[1]})는 [${theirs.label}]이(가) 없어요.`);
      if (st.trade && st.trade.timer) clearTimeout(st.trade.timer);
      st.trade = { from: key, fromNick: author, to: tKey, mine: mine.id, theirs: theirs.id, timer: setTimeout(() => { if (st.trade && st.trade.from === key) { st.trade = null; say(djId, '⌛ 교환 요청이 시간이 지나서 취소됐어요.', 0); } }, 60000) };
      return say(djId, `🔁 ${author}님이 ${parts[1]}님에게 교환을 신청했어요!\n[${mine.label}] ↔ [${theirs.label}]\n${parts[1]}님은 60초 안에 !교환수락 또는 !교환거절`);
    }
    if (head === '!교환수락' || head === '!교환거절') {
      const t = st.trade;
      if (!t || t.to !== key) return;
      clearTimeout(t.timer); st.trade = null;
      if (head === '!교환거절') return say(djId, `🔁 ${author}님이 교환을 거절했어요.`);
      if (owns(mc, t.from, t.mine) < 1 || owns(mc, key, t.theirs) < 1) return say(djId, '⚠️ 둘 중 한 명이 이제 그 몬스터가 없어서 교환이 취소됐어요.');
      take(mc, t.from, t.mine, 1); take(mc, key, t.theirs, 1);
      const evo = (id) => { const to = TRADE_EVO[baseOf(id)]; return to && mc.monsters.some((m) => m.id === to) ? prefixOf(id) + to : null; };
      const gotA = evo(t.theirs) || t.theirs; // 신청한 사람이 받는 것
      const gotB = evo(t.mine) || t.mine;     // 수락한 사람이 받는 것
      give(mc, t.from, gotA, 1); give(mc, key, gotB, 1); A.mcSaveUserData();
      const line = (nick, orig, got) => `${nick}님 ← [${labelOf(mc, orig)}]${got !== orig ? ` ✨교환 진화 → [${labelOf(mc, got)}]` : ''}`;
      say(djId, `🔁 교환 완료!\n${line(t.fromNick, t.theirs, gotA)}\n${line(author, t.mine, gotB)}`);
      checkDex(djId, settings, mc, t.from, t.fromNick); checkDex(djId, settings, mc, key, author);
      return;
    }

    // 🏟️ 체육관
    if (head === '!체육관') {
      const b = (sec('g2badges')[key] || {}).list || [];
      return sayLong(djId, `🏟️ 성도 체육관 (${author}님 배지 ${b.length}/8)\n` + g.gyms.map((x, i) => `${b.includes(i + 1) ? '🏅' : '⬜'} ${i + 1}. ${x.name} — [${labelOf(mc, x.monsterId)}] 공격력 ${x.power}`).join('\n') + '\n!도전 (다음 체육관) 또는 !도전 [번호]');
    }
    if (head === '!도전') {
      if (!started) return needStart();
      const bs = sec('g2badges'); if (!bs[key] || typeof bs[key] !== 'object') bs[key] = { list: [] };
      const have = bs[key].list || (bs[key].list = []);
      let n = parseInt(parts[1], 10);
      if (!n) { n = 0; for (let i = 1; i <= g.gyms.length; i++) if (!have.includes(i)) { n = i; break; } }
      if (!n) return say(djId, `🏅 ${author}님은 이미 배지를 다 모았어요!`);
      const gym = g.gyms[n - 1];
      if (!gym) return say(djId, `⚠️ 체육관은 1~${g.gyms.length}번이에요.`);
      if (have.includes(n)) return say(djId, `🏅 ${author}님은 이미 ${n}번 배지가 있어요!`);
      const cd = g.gymCooldownSec * 1000 - (Date.now() - (st.gymAt.get(key) || 0));
      if (cd > 0) return say(djId, `⏱ ${author}님, ${Math.ceil(cd / 1000)}초 뒤에 다시 도전해주세요!`);
      const me = fighter(mc, key);
      if (!me) return say(djId, `⚠️ ${author}님, 몬스터를 먼저 잡아야 도전할 수 있어요!`);
      st.gymAt.set(key, Date.now());
      const lm = mc.monsters.find((m) => m.id === gym.monsterId) || { name: '관장 몬스터', types: [] };
      const myP = me.power * A.mcTypeMultiplier(me.types, lm.types) * (0.9 + Math.random() * 0.2);
      const lP = gym.power * A.mcTypeMultiplier(lm.types, me.types) * (0.9 + Math.random() * 0.2);
      addFriend(djId, settings, mc, key, author, 3);
      if (myP >= lP) {
        have.push(n); have.sort((a, b) => a - b); saveDex();
        say(djId, `🏟️ ${author}님의 [${me.name}] VS ${gym.name}의 [${lm.name}]\n🏅 승리! ${n}번 배지 획득! (배지 ${have.length}/${g.gyms.length})`);
        if (have.length >= g.gyms.length) award(djId, settings, mc, key, author, 'gym');
      } else say(djId, `🏟️ ${author}님의 [${me.name}] VS ${gym.name}의 [${lm.name}]\n💦 패배... 몬스터를 키워서 다시 도전해보세요! (${g.gymCooldownSec}초 뒤)`);
      return;
    }

    // 🏪 팔기 / 경매
    if (head === '!팔기') {
      if (!started) return needStart();
      let cnt = 1; let nameP = parts.slice(1);
      if (nameP.length > 1 && /^\d+$/.test(nameP[nameP.length - 1])) { cnt = clampInt(nameP.pop(), 1, 999, 1); }
      const f = findByName(mc, nameP.join(' '));
      if (!f) return say(djId, '⚠️ 사용법: !팔기 [몬스터이름] [수량]');
      if (owns(mc, key, f.id) < cnt) return say(djId, `⚠️ [${f.label}]이(가) ${cnt}마리 없어요. (지금 ${owns(mc, key, f.id)}마리)`);
      const each = A.mcDismantlePoints(f.mon.power, f.prefix === A.MC_SHINY_PREFIX, f.prefix === A.MC_GMAX_PREFIX);
      take(mc, key, f.id, cnt); A.mcSaveUserData();
      const total = each * cnt; const now = addPoints(key, total);
      return say(djId, `🏪 ${author}님이 [${f.label}] ${cnt}마리를 팔아서 포인트 +${total} (보유 ${now})`);
    }
    if (head === '!경매') {
      if (!started) return needStart();
      if (st.auction) return say(djId, '⚠️ 이미 경매가 진행 중이에요.');
      let price = 1; const nameP = parts.slice(1);
      if (nameP.length > 1 && /^\d+$/.test(nameP[nameP.length - 1])) price = clampInt(nameP.pop(), 1, 9999999, 1);
      const f = findByName(mc, nameP.join(' '));
      if (!f) return say(djId, '⚠️ 사용법: !경매 [몬스터이름] [시작가(포인트)]');
      if (owns(mc, key, f.id) < 1) return say(djId, `⚠️ ${author}님은 [${f.label}]이(가) 없어요.`);
      st.auction = { seller: key, sellerNick: author, id: f.id, label: f.label, price, best: null, timer: setTimeout(() => endAuction(djId), g.auctionSec * 1000) };
      return say(djId, `🏪 경매 시작! ${author}님의 [${f.label}] · 시작가 ${price}포인트\n${g.auctionSec}초 안에 !입찰 [포인트]`);
    }
    if (head === '!입찰') {
      const a = st.auction; if (!a) return;
      if (a.seller === key) return say(djId, '⚠️ 내 경매에는 입찰할 수 없어요.');
      const amt = clampInt(parts[1], 1, 9999999, 0);
      const min = a.best ? a.best.amount + 1 : a.price;
      if (amt < min) return say(djId, `⚠️ ${min}포인트 이상 입찰해주세요.`);
      if (pointsOf(key) < amt) return say(djId, `⚠️ ${author}님 포인트가 모자라요. (보유 ${pointsOf(key)})`);
      a.best = { key, nick: author, amount: amt };
      return say(djId, `🏪 ${author}님 ${amt}포인트 입찰! (최고가)`);
    }

    // 🎁 아이템
    if (head === '!아이템') {
      const it = itemsOf(key);
      return sayLong(djId, `🎁 아이템 (포인트로 구매 · 하나만 지닐 수 있어요)\n` + ITEMS.map((x) => `${x.icon} ${x.name} ${g.itemPrice[x.id]}P — ${x.desc}${it.owned[x.id] ? ` (보유 ${it.owned[x.id]})` : ''}${it.held === x.id ? ' ✅지니는 중' : ''}`).join('\n') + `\n보유 포인트 ${pointsOf(key)} · !아이템구매 [이름] · !지니기 [이름]`);
    }
    if (head === '!아이템구매') {
      if (!started) return needStart();
      const x = ITEMS.find((i) => i.name === parts.slice(1).join('') || i.name === parts[1]);
      if (!x) return say(djId, `⚠️ 사용법: !아이템구매 [${ITEMS.map((i) => i.name).join('/')}]`);
      const price = g.itemPrice[x.id] || 0;
      if (pointsOf(key) < price) return say(djId, `⚠️ 포인트가 모자라요. (필요 ${price} · 보유 ${pointsOf(key)})`);
      addPoints(key, -price);
      const it = itemsOf(key); it.owned[x.id] = (it.owned[x.id] || 0) + 1; if (!it.held) it.held = x.id; saveDex();
      return say(djId, `🎁 ${author}님이 ${x.icon}${x.name}을(를) 샀어요!${it.held === x.id ? ' (지니는 중)' : ' · !지니기 ' + x.name}`);
    }
    if (head === '!지니기') {
      const x = ITEMS.find((i) => i.name === parts.slice(1).join('') || i.name === parts[1]);
      const it = itemsOf(key);
      if (!x) return say(djId, `⚠️ 사용법: !지니기 [${ITEMS.map((i) => i.name).join('/')}]`);
      if (!it.owned[x.id]) return say(djId, `⚠️ ${x.name}이(가) 없어요. !아이템구매 ${x.name}`);
      it.held = x.id; saveDex();
      return say(djId, `🎁 ${author}님이 ${x.icon}${x.name}을(를) 지녔어요! (${x.desc})`);
    }

    // 🔤 안농 · 🧢 트레이너 카드
    if (head === '!안농') {
      const have = String(sec('g2unown')[key] || '');
      return say(djId, `🔤 ${author}님의 안농 ${have.length}/26\n${LETTERS.split('').map((c) => (have.includes(c) ? c : '·')).join(' ')}`);
    }
    if (head === '!트레이너') {
      const b = (sec('g2badges')[key] || {}).list || [];
      const a = awardsOf(key); const titles = Object.keys(TITLE).filter((k) => a[k]).map((k) => TITLE[k]);
      const eggs = (sec('g2eggs')[key] || []).length;
      const held = ITEMS.find((i) => i.id === heldOf(key));
      return say(djId, `🧢 ${author}님의 트레이너 카드\n🏅 배지 ${b.length}/8 · 🔤 안농 ${String(sec('g2unown')[key] || '').length}/26 · 🥚 알 ${eggs}개\n🎁 ${held ? held.icon + held.name : '지닌 물건 없음'} · 💰 포인트 ${pointsOf(key)}\n${titles.length ? '칭호 ' + titles.join(' ') : '칭호 없음'}`);
    }
  }

  function endAuction(djId) {
    const st = R(djId); const a = st.auction; st.auction = null;
    if (!a) return;
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings);
    if (!a.best) return say(djId, `🏪 [${a.label}] 경매에 입찰한 사람이 없어서 끝났어요.`, 0);
    if (owns(mc, a.seller, a.id) < 1) return say(djId, '🏪 판매자가 이제 그 몬스터가 없어서 경매가 취소됐어요.', 0);
    if (pointsOf(a.best.key) < a.best.amount) return say(djId, `🏪 ${a.best.nick}님 포인트가 모자라서 경매가 취소됐어요.`, 0);
    addPoints(a.best.key, -a.best.amount); addPoints(a.seller, a.best.amount);
    take(mc, a.seller, a.id, 1); give(mc, a.best.key, a.id, 1); A.mcSaveUserData();
    say(djId, `🏪 낙찰! ${a.best.nick}님이 ${a.best.amount}포인트에 [${a.label}]을(를) 가져갔어요! (${a.sellerNick}님 +${a.best.amount}P)`, 0);
    checkDex(djId, settings, mc, a.best.key, a.best.nick);
  }

  function runTourney(djId) {
    const st = R(djId); const t = st.tourney; st.tourney = null;
    if (!t) return;
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings);
    let players = [...t.players.entries()].map(([key, nick]) => ({ key, nick, mon: fighter(mc, key) })).filter((p) => p.mon);
    if (players.length < 2) return say(djId, '🏆 참가자가 2명이 안 돼서 토너먼트가 취소됐어요.', 0);
    players.sort(() => Math.random() - 0.5);
    const lines = [`🏆 몬스터 토너먼트 (${players.length}명)`];
    let round = 1;
    while (players.length > 1) {
      const next = []; const rl = [];
      for (let i = 0; i < players.length; i += 2) {
        const a = players[i], b = players[i + 1];
        if (!b) { next.push(a); rl.push(`${a.nick} 부전승`); continue; }
        const pa = a.mon.power * A.mcTypeMultiplier(a.mon.types, b.mon.types) * (0.9 + Math.random() * 0.2);
        const pb = b.mon.power * A.mcTypeMultiplier(b.mon.types, a.mon.types) * (0.9 + Math.random() * 0.2);
        const w = pa >= pb ? a : b;
        next.push(w); rl.push(`${a.nick}[${a.mon.name}] vs ${b.nick}[${b.mon.name}] → ${w.nick}`);
        addFriend(djId, settings, mc, a.key, a.nick, 3); addFriend(djId, settings, mc, b.key, b.nick, 3);
      }
      lines.push(`— ${next.length === 1 ? '결승' : round + '라운드'} —`, ...rl);
      players = next; round++;
    }
    const champ = players[0];
    const got = grantReward(djId, settings, mc, champ.key, champ.nick, 'tourney');
    lines.push(`👑 우승: ${champ.nick}님의 [${champ.mon.name}]!${got ? ` 보상 ${got}` : ''}`);
    const a = awardsOf(champ.key); a.tourney = a.tourney || Date.now(); a.tourneyWins = (a.tourneyWins || 0) + 1; saveDex();
    sayLong(djId, lines.join('\n'));
  }

  function onOffline(djId) {
    const r = getRoom(djId); const st = r._g2;
    if (!st) return;
    if (st.tourney) { clearTimeout(st.tourney.timer); st.tourney = null; }
    if (st.auction) { clearTimeout(st.auction.timer); st.auction = null; }
    if (st.trade) { clearTimeout(st.trade.timer); st.trade = null; }
    r._g2event = null;
  }

  // 웹 설정 화면용
  // 🏪 웹 도감 상점 (아이템 사기 · 지니기 — 채팅 !아이템구매 · !지니기 와 같아요)
  function shopFor(djId, tag) {
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings); const g = cfgOf(mc);
    const key = String(tag || '').trim().toLowerCase();
    const s = sec('g2items')[key] || {}; const owned = s.owned || {};
    return { success: true, started: mc.bags[key] != null, points: pointsOf(key), held: s.held || '', items: ITEMS.map((x) => ({ ...x, price: g.itemPrice[x.id] || 0, owned: owned[x.id] || 0 })) };
  }
  function shopBuy(djId, tag, itemId, count) {
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings); const g = cfgOf(mc);
    const key = String(tag || '').trim().toLowerCase();
    if (mc.bags[key] == null) return { success: false, error: '먼저 채팅으로 !모험시작 을 해주세요.' };
    const x = ITEMS.find((i) => i.id === itemId); if (!x) return { success: false, error: '없는 아이템이에요.' };
    const n = clampInt(count, 1, 99, 1); const cost = (g.itemPrice[x.id] || 0) * n;
    if (pointsOf(key) < cost) return { success: false, error: `포인트가 모자라요. (필요 ${cost} · 보유 ${pointsOf(key)})` };
    addPoints(key, -cost);
    const it = itemsOf(key); it.owned[x.id] = (it.owned[x.id] || 0) + n; if (!it.held) it.held = x.id; saveDex();
    return { ...shopFor(djId, tag), bought: { id: x.id, name: x.name, icon: x.icon, count: n, cost } };
  }
  function shopHold(djId, tag, itemId) {
    const key = String(tag || '').trim().toLowerCase();
    const x = ITEMS.find((i) => i.id === itemId); if (!x) return { success: false, error: '없는 아이템이에요.' };
    const it = itemsOf(key); if (!it.owned[x.id]) return { success: false, error: `${x.name}이(가) 없어요.` };
    it.held = x.id; saveDex();
    return shopFor(djId, tag);
  }
  function settingsFor(djId) {
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings);
    return { cfg: cfgOf(mc), items: ITEMS, rewardKeys: REWARD_KEYS, rewardLabel: REWARD_LABEL, monsters: mc.monsters.map((m) => ({ id: m.id, name: m.name })) };
  }
  function saveFor(djId, body) {
    const settings = store.getSettings(djId) || {};
    const mc = A.getMonsterCatchSettings(djId, settings);
    mc.g2 = sanitize(body, cfgOf(mc));
    A.mcSaveConfig(djId, mc);
    return mc.g2;
  }

  return { GEN2, ensureGen2, ensureGen2Global, ensureGen2Gmax, pickSpawn, onCaught, onChat, onOffline, catchBonus, powerMult, addFriend, settingsFor, saveFor, shopFor, shopBuy, shopHold };
};
