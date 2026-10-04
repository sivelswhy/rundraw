import { animate, motionValue, type AnimationPlaybackControls } from 'motion';

const PEEK = 132;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const wide = matchMedia('(min-width: 760px)');

/** Projection de l'élan façon défilement iOS (décélération exponentielle). */
function projectMomentum(velocity: number, rate = 0.998) {
  return ((velocity / 1000) * rate) / (1 - rate);
}

/** Résistance progressive au-delà d'une limite. */
function rubberband(overshoot: number, dimension: number, c = 0.55) {
  return (overshoot * dimension * c) / (dimension + c * Math.abs(overshoot));
}

/**
 * Feuille du bas à deux crans (repliée / dépliée).
 * Elle suit le doigt 1:1, se laisse rattraper en plein mouvement et
 * repart à la vitesse du geste au relâcher.
 */
export class Sheet {
  readonly y = motionValue(0);
  private anim?: AnimationPlaybackControls;
  private expanded = true;

  constructor(private el: HTMLElement, handle: HTMLElement) {
    this.y.on('change', (v) => {
      el.style.transform = wide.matches ? '' : `translate3d(0, ${v}px, 0)`;
      el.style.setProperty('--sheet-progress', String(1 - v / Math.max(1, this.max)));
    });

    new ResizeObserver(() => this.settle(false)).observe(el);
    wide.addEventListener('change', () => this.settle(false));
    this.bindDrag(handle);
  }

  /** Débattement : distance entre dépliée et repliée. */
  private get max() {
    return wide.matches ? 0 : Math.max(0, this.el.offsetHeight - PEEK);
  }

  get isExpanded() {
    return this.expanded;
  }

  expand(expanded = true, velocity = 0) {
    this.expanded = expanded;
    this.springTo(expanded ? 0 : this.max, velocity);
  }

  toggle() {
    this.expand(!this.expanded);
  }

  /** Recale la feuille sur son cran après un changement de contenu. */
  settle(animated = true) {
    const target = this.expanded ? 0 : this.max;
    if (animated) this.springTo(target, 0);
    else {
      this.anim?.stop();
      this.y.set(target);
    }
  }

  private springTo(target: number, velocity: number) {
    this.anim?.stop();
    if (reducedMotion.matches) {
      this.y.set(target);
      return;
    }
    // Rebond seulement si le geste portait de l'élan.
    const bounce = Math.abs(velocity) > 600 ? 0.18 : 0;
    this.anim = animate(this.y, target, { type: 'spring', velocity, bounce, visualDuration: 0.32 });
  }

  private bindDrag(handle: HTMLElement) {
    let startY = 0, origin = 0, dragging = false, moved = false;
    let history: { y: number; t: number }[] = [];

    handle.addEventListener('pointerdown', (e) => {
      if (wide.matches || (e.target as HTMLElement).closest('button, input, a')) return;
      handle.setPointerCapture(e.pointerId);
      // Rattrape la feuille là où elle est réellement, même en plein ressort.
      this.anim?.stop();
      dragging = true;
      moved = false;
      startY = e.clientY;
      origin = this.y.get();
      history = [{ y: e.clientY, t: e.timeStamp }];
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (!moved && Math.abs(dy) < 6) return;
      moved = true;
      const raw = origin + dy;
      const max = this.max;
      const h = this.el.offsetHeight;
      this.y.set(raw < 0 ? rubberband(raw, h) : raw > max ? max + rubberband(raw - max, h) : raw);
      history.push({ y: e.clientY, t: e.timeStamp });
      if (history.length > 6) history.shift();
    });

    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      if (!moved) {
        this.toggle();
        return;
      }
      // Vitesse sur les ~100 dernières ms : un doigt immobile avant de lâcher n'a pas d'élan.
      const first = history.find((h) => e.timeStamp - h.t < 100);
      const dt = first ? (e.timeStamp - first.t) / 1000 : 0;
      const velocity = first && dt > 0 ? (e.clientY - first.y) / dt : 0;
      const projected = this.y.get() + projectMomentum(velocity);
      this.expand(projected < this.max / 2, velocity);
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}
