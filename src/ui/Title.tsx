import type { Mode } from '../state/store'

export function TitleScreen({ ready, onStart }: { ready: boolean; onStart: (m: Mode) => void }) {
  return (
    <div className="title-screen">
      <h1>SKYCLEAVER</h1>
      <button disabled={!ready} onClick={() => onStart('campaign')}>
        Begin
      </button>
      <button disabled={!ready} onClick={() => onStart('sandbox')}>
        Sandbox
      </button>
    </div>
  )
}
