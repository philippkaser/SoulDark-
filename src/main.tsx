import '@fontsource/cinzel/400.css'
import '@fontsource/cinzel/600.css'
import '@fontsource/eb-garamond/400.css'
import '@fontsource/eb-garamond/500.css'
import '@fontsource/eb-garamond/400-italic.css'
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
