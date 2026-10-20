export function SwordIcon() {
  return (
    <svg viewBox="0 0 48 48">
      <defs>
        <linearGradient id="bl" x1="0" x2="1">
          <stop offset="0" stopColor="#8d949c" />
          <stop offset="0.5" stopColor="#e6ebf0" />
          <stop offset="1" stopColor="#7d848c" />
        </linearGradient>
      </defs>
      <path d="M38 6 L41 9 L20 30 L17 27 Z" fill="url(#bl)" stroke="#222" strokeWidth="0.6" />
      <path d="M13 28 L20 35 L18 37 L11 30 Z" fill="#a8843e" />
      <path d="M12 36 L16 32 L18 34 L14 38 Z" fill="#3a2a1e" />
      <circle cx="10.5" cy="39.5" r="2.2" fill="#a8843e" />
    </svg>
  )
}

export function ShieldIcon() {
  return (
    <svg viewBox="0 0 48 48">
      <path d="M10 8 H38 V22 C38 32 31 39 24 43 C17 39 10 32 10 22 Z" fill="#6b1515" stroke="#9aa0a8" strokeWidth="2.4" />
      <circle cx="24" cy="21" r="7" fill="none" stroke="#c9a453" strokeWidth="2" />
      <circle cx="24" cy="21" r="4" fill="#120c08" />
    </svg>
  )
}

export function FlaskIcon({ empty }: { empty?: boolean }) {
  return (
    <svg viewBox="0 0 48 48">
      <defs>
        <radialGradient id="ef" cx="0.5" cy="0.6" r="0.6">
          <stop offset="0" stopColor={empty ? '#333' : '#ffe2a0'} />
          <stop offset="0.45" stopColor={empty ? '#222' : '#ff8a2a'} />
          <stop offset="1" stopColor={empty ? '#111' : '#7a2a08'} />
        </radialGradient>
      </defs>
      <rect x="20" y="5" width="8" height="9" rx="1.5" fill="#3a3a32" />
      <path d="M19 13 H29 V17 C35 19 38 24 38 30 C38 38 32 43 24 43 C16 43 10 38 10 30 C10 24 13 19 19 17 Z" fill="#26332a" stroke="#596b58" strokeWidth="1.2" />
      <path d="M12.5 30 C12.5 26 15 23 18 22 H30 C33 23 35.5 26 35.5 30 C35.5 37 30.5 40.5 24 40.5 C17.5 40.5 12.5 37 12.5 30 Z" fill="url(#ef)" />
    </svg>
  )
}
