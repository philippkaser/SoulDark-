import '@fontsource/barlow-condensed/500.css'
import '@fontsource/barlow-condensed/700-italic.css'
import '@fontsource/barlow-condensed/800-italic.css'
import '@fontsource/cinzel/600.css'
import '@fontsource/cinzel/900.css'
import './ui/styles.css'
import { lazy, StrictMode, Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// developer tool: ?debug=poses renders animation clips frame by frame
const PoseViewer = lazy(() => import('./debug/PoseViewer').then((m) => ({ default: m.PoseViewer })))
const debug = new URLSearchParams(location.search).get('debug')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {debug === 'poses' ? (
      <Suspense fallback={null}>
        <PoseViewer />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)
