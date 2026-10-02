import { useRef, type CSSProperties } from 'react';
import { KeyRound, Play } from 'lucide-react';
import { ExplainerPlayer, type ExplainerHandle } from './ExplainerPlayer';
import './hero.css';

// staggered rise-in, one step per line (hero.css)
const rise = (step: number) => ({ '--rise': step }) as CSSProperties;

/**
 * The first screen: what this is for in one line, the one gold button that
 * takes you to the tool, and the two-minute explainer in a phone beside it.
 * On phones the phone sits under the text and opens the video full screen.
 */
export function Hero({ onStartRecovering }: { onStartRecovering: () => void }) {
  const player = useRef<ExplainerHandle>(null);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-copy">
        <p className="eyebrow hero-rise" style={rise(0)}>Recover BSV from a BIP-39 phrase</p>
        <h1 id="hero-title" className="hero-title hero-rise" style={rise(1)}>
          A seed phrase isn't enough. You need the right path.
        </h1>
        <p className="hero-sub hero-rise" style={rise(2)}>
          Old wallet gone, or showing zero? Your coins are likely still on the blockchain, on a path your new wallet doesn't check.
        </p>
        <div className="hero-actions hero-rise" style={rise(3)}>
          <button type="button" className="btn btn-primary" onClick={onStartRecovering}><KeyRound size={17} /> Start recovering</button>
          <button type="button" className="btn btn-ghost hero-watch" onClick={() => player.current?.play()}><Play size={16} /> Watch the explainer</button>
        </div>
        <p className="hero-meta hero-rise" style={rise(4)}>2 min · with sound · everything runs in your browser</p>
      </div>
      <div className="hero-stage hero-rise" style={rise(2)}>
        <span className="hero-glow" aria-hidden />
        <ExplainerPlayer ref={player} onStartRecovering={onStartRecovering} />
      </div>
    </section>
  );
}
