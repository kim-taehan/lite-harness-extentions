// 코드 블록 복사 버튼 · 목차 하이라이트 · 첫 화면 가이드 찾기

for (const pre of document.querySelectorAll('.code pre')) {
  const button = document.createElement('button')
  button.className = 'copy'
  button.type = 'button'
  button.textContent = '복사'
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(pre.innerText)
      button.textContent = '복사됨'
    } catch {
      button.textContent = '복사 실패'
    }
    setTimeout(() => (button.textContent = '복사'), 1500)
  })
  pre.parentElement.append(button)
}

const tocLinks = [...document.querySelectorAll('.toc a')]
if (tocLinks.length > 0) {
  const byId = new Map(tocLinks.map((link) => [link.hash.slice(1), link]))
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        for (const link of tocLinks) link.classList.toggle('active', link === byId.get(entry.target.id))
      }
    },
    { rootMargin: '-80px 0px -70% 0px' },
  )
  for (const id of byId.keys()) {
    const section = document.getElementById(id)
    if (section) observer.observe(section)
  }
}

const search = document.querySelector('#guide-search')
if (search) {
  const cards = [...document.querySelectorAll('.cards .card')]
  const empty = document.querySelector('.empty')
  search.addEventListener('input', () => {
    const query = search.value.trim().toLowerCase()
    let shown = 0
    for (const card of cards) {
      const match = card.textContent.toLowerCase().includes(query)
      card.hidden = !match
      if (match) shown++
    }
    empty.style.display = shown === 0 ? 'block' : 'none'
  })
}
