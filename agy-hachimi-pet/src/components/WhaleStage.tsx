import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import type { PetReactionEvent, PetSettings, SubagentItem } from '../types';

export const SCHEME_COLORS: Record<string, string> = {
  astral: '#8B7BF7',
  sakura: '#F472B6',
  azure: '#38BDF8',
  emerald: '#34D399',
  amber: '#F59E0B',
  crimson: '#FB7185',
  arctic: '#94A3B8',
  obsidian: '#6366F1',
  // Legacy compatibility aliases
  gemini: '#8B7BF7',
  deepseek: '#38BDF8',
  claude: '#F59E0B',
  chatgpt: '#94A3B8',
  qwen: '#8B7BF7',
  kimi: '#34D399',
  minimax: '#F472B6',
  harness: '#6366F1',
};

const VALID_SCHEMES = new Set(['astral', 'sakura', 'azure', 'emerald', 'amber', 'crimson', 'arctic', 'obsidian']);
const LEGACY_TO_CATGIRL: Record<string, string> = {
  gemini: 'astral',
  deepseek: 'azure',
  claude: 'amber',
  chatgpt: 'arctic',
  qwen: 'astral',
  kimi: 'emerald',
  minimax: 'sakura',
  harness: 'obsidian',
};

function resolveCatgirlCombo(scheme?: string): string {
  const s = String(scheme || 'astral').toLowerCase();
  const mapped = VALID_SCHEMES.has(s) ? s : (LEGACY_TO_CATGIRL[s] || 'astral');
  return `${mapped}-maid`;
}

export interface WhaleControllerHandle {
  triggerReaction: (ev: PetReactionEvent) => void;
  resetCornerPosition: () => void;
  doWord: (word: string) => void;
}

interface WhaleStageProps {
  settings: PetSettings;
  subagents?: SubagentItem[];
  hudScale: number;
  hudGap: number;
  onAnchorMove?: (pos: { x: number; y: number; sideX: number; sideY: number }) => void;
  onDiag?: (diag: Record<string, unknown>) => void;
}

const dynamicImport = new Function('url', 'return import(url)') as (url: string) => Promise<any>;

/**
 * Compute non-overlapping horizontal lane X for a subagent based on `slotIndex` and stage width.
 */
function computeSubagentLaneX(slotIndex: number, stageWidth: number): number {
  const usableRight = Math.max(260, stageWidth - 280);
  const usableLeft = 105;
  const span = Math.max(140, usableRight - usableLeft);
  const spacing = 148;
  const maxCols = Math.max(1, Math.floor(span / spacing) + 1);
  const col = slotIndex % maxCols;
  const wave = Math.floor(slotIndex / maxCols);
  const stagger = wave % 2 === 1 ? 68 : 0;
  return Math.max(usableLeft, Math.min(usableRight, usableRight - col * spacing - stagger));
}

/**
 * Gently resolve horizontal/vertical overlaps between overhead subagent HUD cards so every name & progress bar stays readable.
 */
function resolveHudLayout(
  subagents: SubagentItem[],
  anchors: Record<string, { x: number; y: number }>,
  stageWidth: number,
  hudScale: number,
  hudGap: number
): Record<string, { x: number; y: number }> {
  const placed: Array<{ id: string; x: number; y: number }> = [];
  const sorted = [...subagents]
    .filter((s) => Boolean(anchors[s.id]))
    .sort((a, b) => (anchors[a.id]?.x ?? 0) - (anchors[b.id]?.x ?? 0));

  const minX = Math.min(stageWidth / 2, 110 * hudScale);
  const maxX = stageWidth - minX;
  const pillHalfW = 86 * hudScale;

  for (const sub of sorted) {
    const raw = anchors[sub.id];
    const x = Math.max(minX, Math.min(maxX, raw.x));
    let y = raw.y - hudGap;

    for (const prev of placed) {
      const dx = Math.abs(x - prev.x);
      const dy = Math.abs(y - prev.y);
      if (dx < pillHalfW * 1.85 && dy < 46 * hudScale) {
        // Stack vertically above the neighboring pill if whales are standing very close
        y = prev.y - 52 * hudScale;
      }
    }
    placed.push({ id: sub.id, x, y });
  }

  const out: Record<string, { x: number; y: number }> = {};
  for (const p of placed) out[p.id] = { x: p.x, y: p.y };
  return out;
}

/**
 * Inspect `[data-pet-interactive="true"]` elements with strict anti-masking circuit breakers.
 */
function collectInteractiveRects() {
  const vw = window.innerWidth || 1920;
  const vh = window.innerHeight || 1080;
  const nodes = document.querySelectorAll<HTMLElement>('[data-pet-interactive="true"]');
  const validRects: Array<{ cls: string; x: number; y: number; w: number; h: number }> = [];
  let skippedOversized = 0;

  for (let i = 0; i < nodes.length; i++) {
    const el = nodes[i];
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;

    // Circuit breaker: NEVER allow any full-screen or oversized wrapper (>55% width & >55% height) to block desktop clicks!
    if (r.width > vw * 0.55 && r.height > vh * 0.55) {
      skippedOversized++;
      continue;
    }

    const cs = window.getComputedStyle(el);
    if (
      cs.pointerEvents === 'none' ||
      cs.visibility === 'hidden' ||
      cs.display === 'none' ||
      cs.opacity === '0'
    ) {
      continue;
    }

    validRects.push({
      cls: el.className || el.tagName,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
    });
  }

  return { validRects, skippedOversized };
}

export const WhaleStage = forwardRef<WhaleControllerHandle, WhaleStageProps>(function WhaleStage(
  { settings, subagents = [], hudScale, hudGap, onAnchorMove, onDiag },
  ref
) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const shadowRef = useRef<SVGEllipseElement | null>(null);
  const petGRef = useRef<SVGGElement | null>(null);
  const fxGRef = useRef<SVGGElement | null>(null);

  const ctlRef = useRef<any>(null);
  const figRef = useRef<any>(null);
  const sfxRef = useRef<any>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const scaleRef = useRef(settings.scale);
  scaleRef.current = settings.scale;

  // Subagents controllers, fade-out exit queue, and anchor positions
  const subCtlsRef = useRef<
    Map<string, { ctl: any; figure: any; item: SubagentItem; lastStatus?: string; lastText?: string }>
  >(new Map());
  const spawningIdsRef = useRef<Set<string>>(new Set());
  const exitingIdsRef = useRef<Set<string>>(new Set());
  const exitTimersRef = useRef<Map<string, number>>(new Map());
  const [renderSubs, setRenderSubs] = useState<Array<SubagentItem & { exiting?: boolean }>>([]);
  const [subAnchors, setSubAnchors] = useState<Record<string, { x: number; y: number }>>({});
  const kitRef = useRef<{ createPet: any; createWhaleFigure: any; origin: string } | null>(null);

  const speechStateRef = useRef<{ text: string; idx: number; nextAt: number }>({
    text: '',
    idx: 0,
    nextAt: 0,
  });

  const onAnchorMoveRef = useRef(onAnchorMove);
  onAnchorMoveRef.current = onAnchorMove;
  const onDiagRef = useRef(onDiag);
  onDiagRef.current = onDiag;

  useImperativeHandle(ref, () => ({
    triggerReaction(ev: PetReactionEvent) {
      const ctl = ctlRef.current;
      if (!ctl) return;
      ctl.holdRoam(7);
      if (typeof ev.thinking === 'boolean') {
        ctl.setThinking(ev.thinking);
      }
      if (ev.expression) {
        ctl.setExpr(ev.expression, 3.2);
      }
      if (ev.motion) {
        ctl.doWord(ev.motion);
      }
      if (ev.speech) {
        speechStateRef.current = { text: ev.speech, idx: 0, nextAt: 0 };
      }
    },
    resetCornerPosition() {
      const ctl = ctlRef.current;
      if (!ctl || !stageRef.current) return;
      const r = stageRef.current.getBoundingClientRect();
      ctl.stopWalk?.();
      ctl.pet.x = Math.max(120, r.width - 145);
      ctl.pet.target = ctl.pet.x;
      ctl.pet.facing = -1;
      ctl.pet.faceVis = -1;
      ctl.setExpr('happy', 1.5);
      ctl.doWord('wave');
    },
    doWord(word: string) {
      const ctl = ctlRef.current;
      if (!ctl) return;
      ctl.holdRoam(5);
      ctl.doWord(word);
    },
  }));

  // Mount Coopanion Whale figure + physics kit once
  useEffect(() => {
    let cancelled = false;
    let rafId = 0;
    let ro: ResizeObserver | null = null;

    async function boot() {
      const stage = stageRef.current;
      const shadowEl = shadowRef.current;
      const petG = petGRef.current;
      const fxG = fxGRef.current;
      if (!stage || !shadowEl || !petG || !fxG) return;

      const origin = window.location.origin;
      const [{ createPet }, { createSfx }, { createWhaleFigure }] = await Promise.all([
        dynamicImport(`${origin}/coopanion/kit/body.js`),
        dynamicImport(`${origin}/coopanion/sound.js`),
        dynamicImport(`${origin}/coopanion/whale/figure.js`),
      ]);
      if (cancelled) return;

      kitRef.current = { createPet, createWhaleFigure, origin };

      const sfx = createSfx({ storageKey: 'agy-whale-pet.sound', volume: 0.45 });
      sfx.set(settingsRef.current.soundOn);
      sfxRef.current = sfx;

      const unlock = () => sfx.unlock();
      window.addEventListener('pointerdown', unlock, { capture: true });
      window.addEventListener('keydown', unlock, { capture: true });

      const initialCombo = resolveCatgirlCombo(settingsRef.current.scheme);
      const figure = await createWhaleFigure(new URL('/coopanion/whale/', origin), {
        scheme: initialCombo,
      });
      if (cancelled) {
        figure.dispose?.();
        return;
      }
      figRef.current = figure;

      const latestCombo = resolveCatgirlCombo(settingsRef.current.scheme);
      if (figure.scheme !== latestCombo) {
        await figure.setScheme(latestCombo);
        if (cancelled) {
          figure.dispose?.();
          return;
        }
      }

      const rect0 = stage.getBoundingClientRect();
      const startX = Math.max(160, rect0.width - 155);

      const ctl = createPet(
        { petG, shadowEl, fxG },
        {
          sfx,
          figure,
          roam: settingsRef.current.roam,
          enter: 'drop',
          startX,
          bounds: () => {
            const r = stage.getBoundingClientRect();
            return {
              W: r.width,
              H: r.height,
              floorY: r.height - 14,
              S: 0.58 * scaleRef.current,
            };
          },
        }
      );
      ctl.pet.x = startX;
      ctl.pet.facing = -1;
      ctl.pet.faceVis = -1;
      ctl.setRoam(settingsRef.current.roam);
      sfx.set(settingsRef.current.soundOn);
      ctlRef.current = ctl;

      ro = new ResizeObserver(() => {
        ctl.resize();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.resize();
        }
      });
      ro.observe(stage);

      let last = performance.now();
      let lastAnchorReport = 0;
      let lastSubAnchorReport = 0;
      let lastDiagReport = 0;
      let prevAnchor = { x: -1, y: -1, sideX: -1, sideY: -1 };
      let prevSubKeys = '';
      let prevSubPos: Record<string, { x: number; y: number }> = {};

      const loop = (now: number) => {
        if (cancelled) return;
        const elapsedMs = now - last;

        // Adaptive frame pacing:
        // - Active movement / drag / jump / talk / subagent sky-drop -> smooth ~50fps (min 18ms)
        // - Gentle idle / sleep breathing -> power-saving ~24fps (40ms) to cut GPU/CPU by >55%
        const mainMode = ctl.pet?.mode;
        const isMainActive =
          mainMode === 'walk' ||
          mainMode === 'run' ||
          mainMode === 'air' ||
          mainMode === 'drag' ||
          mainMode === 'crouch' ||
          mainMode === 'dance' ||
          ctl.pet?.pulse ||
          Boolean(speechStateRef.current.text);
        let hasActiveSub = false;
        for (const ent of subCtlsRef.current.values()) {
          const sm = ent.ctl.pet?.mode;
          if (sm === 'air' || sm === 'drag' || sm === 'crouch' || ent.ctl.pet?.pulse) {
            hasActiveSub = true;
            break;
          }
        }
        const minFrameMs = isMainActive || hasActiveSub ? 18 : 40;
        if (elapsedMs < minFrameMs) {
          rafId = requestAnimationFrame(loop);
          return;
        }

        const dt = Math.min(0.05, elapsedMs / 1000);
        last = now;

        // Drive mouth lip-sync while speech text types out for main pet
        const sp = speechStateRef.current;
        if (sp.text && now >= sp.nextAt) {
          if (sp.idx < sp.text.length) {
            const ch = sp.text[sp.idx++];
            ctl.talk();
            sfx.babble(ch);
            sp.nextAt = now + 62;
          } else {
            sp.text = '';
          }
        }

        ctl.step(dt);
        ctl.render();

        // Step and render subagent pets (syncing native sleep / wake poses seamlessly!)
        let nextSubKeys = '';
        let subMoved = false;
        const nextSubAnchors: Record<string, { x: number; y: number }> = {};
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (!exitingIdsRef.current.has(id)) {
            const pMode = entry.ctl.pet?.mode;
            const isBusyAir = pMode === 'air' || pMode === 'drag' || pMode === 'crouch';
            if (entry.item.status === 'WAITING') {
              if (!isBusyAir && pMode !== 'sleep') {
                entry.ctl.setThinking?.(false);
                entry.ctl.doWord?.('sleep');
              }
            } else if (pMode === 'sleep' || pMode === 'sit') {
              entry.ctl.doWord?.('stand');
            }
          }
          entry.ctl.step(dt);
          entry.ctl.render();
          const anc = entry.ctl.anchor();
          const ax = Math.round(anc.x);
          const ay = Math.round(anc.y);
          nextSubAnchors[id] = { x: ax, y: ay };
          nextSubKeys += `${id}|`;
          const prevP = prevSubPos[id];
          if (!prevP || Math.abs(ax - prevP.x) >= 1 || Math.abs(ay - prevP.y) >= 1) {
            subMoved = true;
          }
        }

        if ((subMoved || nextSubKeys !== prevSubKeys) && now - lastSubAnchorReport > 36) {
          lastSubAnchorReport = now;
          prevSubKeys = nextSubKeys;
          prevSubPos = nextSubAnchors;
          setSubAnchors(nextSubAnchors);
        }

        if (ctl.pet.mode !== 'air' && (lastDiagReport === 0 || now - lastDiagReport > 8000)) {
          lastDiagReport = now;
          const cv = petG.querySelector('canvas');
          const lay = ctl.layout();
          const hitSummary = collectInteractiveRects();
          onDiagRef.current?.({
            loaded: true,
            scheme: figure.scheme,
            mode: ctl.pet.mode,
            x: Math.round(ctl.pet.x),
            fy: Math.round(ctl.pet.fy),
            box: lay.box,
            canvasW: cv?.width ?? 0,
            canvasH: cv?.height ?? 0,
            subagentCount: subCtlsRef.current.size,
            interactiveRects: hitSummary.validRects,
            skippedOversizedRects: hitSummary.skippedOversized,
          });
        }

        if (now - lastAnchorReport > 36) {
          lastAnchorReport = now;
          const a = ctl.anchor();
          const lay = ctl.layout();
          const ax = Math.round(a.x);
          const ay = Math.round(a.y);
          const sx = Math.round(lay.side.x);
          const sy = Math.round(lay.side.y);
          if (
            Math.abs(ax - prevAnchor.x) >= 1 ||
            Math.abs(ay - prevAnchor.y) >= 1 ||
            Math.abs(sx - prevAnchor.sideX) >= 1 ||
            Math.abs(sy - prevAnchor.sideY) >= 1
          ) {
            prevAnchor = { x: ax, y: ay, sideX: sx, sideY: sy };
            onAnchorMoveRef.current?.({ x: ax, y: ay, sideX: sx, sideY: sy });
          }
        }

        rafId = requestAnimationFrame(loop);
      };
      rafId = requestAnimationFrame(loop);
    }

    boot().catch((err) => {
      console.error('[WhaleStage] Failed to boot Coopanion Whale:', err);
      onDiagRef.current?.({ loaded: false, error: String(err?.stack || err?.message || err) });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      ro?.disconnect();
      figRef.current?.dispose?.();
      ctlRef.current = null;
      for (const t of exitTimersRef.current.values()) {
        window.clearTimeout(t);
      }
      exitTimersRef.current.clear();
      exitingIdsRef.current.clear();
      for (const entry of subCtlsRef.current.values()) {
        entry.figure?.dispose?.();
      }
      subCtlsRef.current.clear();
      spawningIdsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Sync subagents spawn, live status expressions & smooth fade-out removal
  useEffect(() => {
    const kit = kitRef.current;
    const stage = stageRef.current;
    const currentMap = subCtlsRef.current;
    const activeMap = new Map(subagents.map((s) => [s.id, s]));

    // Update renderSubs: keep active subagents, and transition newly removed ones into 480ms smooth fade-out!
    setRenderSubs((prev) => {
      const next: Array<SubagentItem & { exiting?: boolean }> = [];
      const seen = new Set<string>();

      for (const s of subagents) {
        seen.add(s.id);
        const existingTimer = exitTimersRef.current.get(s.id);
        if (existingTimer) {
          window.clearTimeout(existingTimer);
          exitTimersRef.current.delete(s.id);
        }
        exitingIdsRef.current.delete(s.id);
        next.push({ ...s, exiting: false });
      }

      for (const oldItem of prev) {
        if (seen.has(oldItem.id)) continue;
        exitingIdsRef.current.add(oldItem.id);
        spawningIdsRef.current.delete(oldItem.id);

        if (!exitTimersRef.current.has(oldItem.id)) {
          const entry = currentMap.get(oldItem.id);
          entry?.ctl?.setThinking?.(false);
          entry?.ctl?.setExpr?.('happy', 1.2);

          const tid = window.setTimeout(() => {
            exitTimersRef.current.delete(oldItem.id);
            exitingIdsRef.current.delete(oldItem.id);
            const ent = subCtlsRef.current.get(oldItem.id);
            ent?.figure?.dispose?.();
            subCtlsRef.current.delete(oldItem.id);
            setRenderSubs((cur) => cur.filter((x) => x.id !== oldItem.id));
          }, 480);
          exitTimersRef.current.set(oldItem.id, tid);
        }

        next.push({ ...oldItem, exiting: true });
      }

      return next;
    });

    if (!kit || !stage) return;

    // Spawn new subagents or sync live status/progress animations
    subagents.forEach((sub, index) => {
      if (currentMap.has(sub.id)) {
        const entry = currentMap.get(sub.id)!;
        entry.item = sub;
        if (entry.lastStatus !== sub.status) {
          entry.lastStatus = sub.status;
          if (sub.status === 'DONE') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.setExpr?.('happy', 2.0);
          } else if (sub.status === 'THINKING') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(true);
            entry.ctl?.setExpr?.('thinking', 2.5);
          } else if (sub.status === 'WAITING') {
            entry.ctl?.setThinking?.(false);
            entry.ctl?.doWord?.('sleep');
          } else if (sub.status === 'ERROR') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.setExpr?.('flustered', 3.0);
            entry.ctl?.doWord?.('shiver');
          } else if (sub.status === 'WORKING') {
            if (entry.ctl?.pet?.mode === 'sleep') entry.ctl?.doWord?.('stand');
            entry.ctl?.setThinking?.(false);
            entry.ctl?.setExpr?.('determined', 2.5);
          }
        } else if (entry.lastText !== sub.progressText && sub.status === 'WORKING') {
          entry.lastText = sub.progressText;
          entry.ctl?.setExpr?.('determined', 1.8);
          entry.ctl?.talk?.();
        }
        return;
      }

      if (spawningIdsRef.current.has(sub.id)) return;
      spawningIdsRef.current.add(sub.id);

      // Stagger simultaneous sky-drops slightly (95ms apart) so parallel Swarm/Teamwork waves look super lively!
      const dropDelayMs = 45 + (index % 6) * 95;
      setTimeout(async () => {
        if (!kitRef.current || !stageRef.current || exitingIdsRef.current.has(sub.id)) {
          spawningIdsRef.current.delete(sub.id);
          return;
        }
        const shadowEl = document.getElementById(`sub-shadow-${sub.id}`) as any;
        const petG = document.getElementById(`sub-pet-${sub.id}`) as any;
        const fxG = document.getElementById(`sub-fx-${sub.id}`) as any;
        if (!shadowEl || !petG || !fxG) {
          spawningIdsRef.current.delete(sub.id);
          return;
        }

        try {
          const combo = resolveCatgirlCombo(sub.scheme);
          const figure = await kit.createWhaleFigure(new URL('/coopanion/whale/', kit.origin), {
            scheme: combo,
          });
          if (exitingIdsRef.current.has(sub.id)) {
            figure.dispose?.();
            return;
          }
          const stageW = stage.getBoundingClientRect().width || window.innerWidth;
          const laneIdx = typeof sub.slotIndex === 'number' ? sub.slotIndex : index;
          const startX = computeSubagentLaneX(laneIdx, stageW);

          const subCtl = kit.createPet(
            { petG, shadowEl, fxG },
            {
              sfx: sfxRef.current,
              figure,
              roam: 'off',
              enter: 'drop', // Physical sky-drop with gravity & squash-bounce
              startX,
              bounds: () => {
                const r = stage.getBoundingClientRect();
                return {
                  W: r.width,
                  H: r.height,
                  floorY: r.height - 14,
                  S: 0.47 * scaleRef.current,
                };
              },
            }
          );
          subCtl.pet.x = startX;
          subCtl.pet.facing = -1;
          subCtl.pet.faceVis = -1;
          subCtl.setExpr('determined', 2.8);
          currentMap.set(sub.id, {
            ctl: subCtl,
            figure,
            item: sub,
            lastStatus: sub.status,
            lastText: sub.progressText,
          });
        } catch (e) {
          console.error('[WhaleStage] Failed to spawn subagent pet:', e);
        } finally {
          spawningIdsRef.current.delete(sub.id);
        }
      }, dropDelayMs);
    });
  }, [subagents]);

  // Sync color scheme live for main pet
  useEffect(() => {
    const fig = figRef.current;
    const ctl = ctlRef.current;
    if (!fig) return;
    const combo = resolveCatgirlCombo(settings.scheme);
    if (fig.scheme !== combo) {
      fig.setScheme(combo, { fade: 0.42 }).then(() => {
        if (ctl) {
          ctl.pet.sqv += 1.1;
          ctl.setExpr('happy', 1.1);
        }
      });
    }
  }, [settings.scheme, settings.outfit]);

  // Sync roam, scale, and sound settings
  useEffect(() => {
    ctlRef.current?.setRoam(settings.roam);
  }, [settings.roam]);

  useEffect(() => {
    ctlRef.current?.resize();
    for (const entry of subCtlsRef.current.values()) {
      entry.ctl?.resize();
    }
  }, [settings.scale]);

  useEffect(() => {
    sfxRef.current?.set(settings.soundOn);
  }, [settings.soundOn]);

  // Windows click-through cursor polling hit-test integration (with anti-masking circuit breaker)
  useEffect(() => {
    if (!window.petHost) return;
    return window.petHost.onCursor((pt) => {
      if (pt.locked || !pt.insideWindow) {
        window.petHost?.setMouseCapture(false);
        return;
      }
      const ctl = ctlRef.current;
      let overWhale = false;
      if (ctl) {
        overWhale = !!(ctl.pressing || ctl.hitPet({ x: pt.x, y: pt.y }));
      }
      if (!overWhale) {
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (exitingIdsRef.current.has(id)) continue;
          if (entry.ctl?.pressing || entry.ctl?.hitPet({ x: pt.x, y: pt.y })) {
            overWhale = true;
            break;
          }
        }
      }

      let overUI = false;
      if (!overWhale) {
        const vw = window.innerWidth || 1920;
        const vh = window.innerHeight || 1080;
        const nodes = document.querySelectorAll<HTMLElement>('[data-pet-interactive="true"]');
        for (let i = 0; i < nodes.length; i++) {
          const el = nodes[i];
          const r = el.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) continue;
          // Circuit breaker: ignore any oversized layout layer (>55% screen width & height)
          if (r.width > vw * 0.55 && r.height > vh * 0.55) continue;
          const cs = window.getComputedStyle(el);
          if (
            cs.pointerEvents === 'none' ||
            cs.visibility === 'hidden' ||
            cs.display === 'none' ||
            cs.opacity === '0'
          ) {
            continue;
          }
          if (
            pt.x >= r.left - 6 &&
            pt.x <= r.right + 6 &&
            pt.y >= r.top - 6 &&
            pt.y <= r.bottom + 6
          ) {
            overUI = true;
            break;
          }
        }
      }

      window.petHost?.setMouseCapture(overWhale || overUI);
    });
  }, []);

  const toStagePoint = (e: React.PointerEvent | React.MouseEvent) => {
    const r = stageRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
  };

  const stageWidth = stageRef.current?.clientWidth || window.innerWidth || 1920;
  const hudPositions = resolveHudLayout(renderSubs, subAnchors, stageWidth, hudScale, hudGap);

  return (
    <div
      ref={stageRef}
      className="whale-stage"
      style={{ opacity: settings.opacity ?? 1 }}
      onPointerDown={(e) => {
        if (e.button === 2) {
          const ptR = toStagePoint(e);
          if (ctlRef.current?.hitPet(ptR)) {
            e.preventDefault();
            ctlRef.current?.doWord?.('wave');
            ctlRef.current?.setExpr?.('happy', 1.8);
          }
          return;
        }
        const pt = toStagePoint(e);
        const ctl = ctlRef.current;
        if (ctl?.pointerDown(pt)) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          return;
        }
        // Subagent drag & click interaction (skip fading-out pets)
        for (const [id, entry] of subCtlsRef.current.entries()) {
          if (exitingIdsRef.current.has(id)) continue;
          if (entry.ctl?.pointerDown(pt)) {
            (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
            entry.ctl.setExpr('wink', 1.6);
            return;
          }
        }
      }}
      onPointerMove={(e) => {
        const pt = toStagePoint(e);
        const ctl = ctlRef.current;
        if (ctl) {
          const cur = ctl.pointerMove(pt);
          if (cur && stageRef.current) {
            stageRef.current.style.cursor = cur;
            return;
          }
        }
        for (const entry of subCtlsRef.current.values()) {
          const cur = entry.ctl?.pointerMove(pt);
          if (cur && stageRef.current) {
            stageRef.current.style.cursor = cur;
            return;
          }
        }
        if (stageRef.current) stageRef.current.style.cursor = '';
      }}
      onPointerUp={() => {
        ctlRef.current?.pointerUp();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.pointerUp();
        }
      }}
      onPointerLeave={() => {
        ctlRef.current?.pointerLeave();
        for (const entry of subCtlsRef.current.values()) {
          entry.ctl?.pointerLeave();
        }
      }}
      onDoubleClick={(e) => {
        const pt = toStagePoint(e);
        if (ctlRef.current?.hitPet(pt)) {
          ctlRef.current.doWord('dance');
          ctlRef.current.setExpr('excited', 2.4);
          return;
        }
        for (const entry of subCtlsRef.current.values()) {
          if (entry.ctl?.hitPet(pt)) {
            entry.ctl.doWord('spin');
            entry.ctl.setExpr('excited', 2);
            return;
          }
        }
      }}
      onContextMenu={(e) => {
        const pt = toStagePoint(e);
        if (ctlRef.current?.hitPet(pt)) {
          e.preventDefault();
        }
      }}
    >
      <svg className="whale-svg" aria-hidden="true">
        {/* Main Pet Figures */}
        <ellipse ref={shadowRef} className="shadow" cx="0" cy="0" rx="0" ry="0" />
        <g ref={petGRef} />
        <g ref={fxGRef} />

        {/* Dynamic Subagent Pets SVG Containers (with smooth fade-out on removal) */}
        {renderSubs.map((sub) => (
          <g key={sub.id} className={`subagent-svg-group ${sub.exiting ? 'is-exiting' : ''}`}>
            <ellipse id={`sub-shadow-${sub.id}`} className="shadow" cx="0" cy="0" rx="0" ry="0" />
            <g id={`sub-pet-${sub.id}`} />
            <g id={`sub-fx-${sub.id}`} />
          </g>
        ))}
      </svg>

      {/* Dynamic Subagents Overhead HUD Layer — strictly click-through on container, interactive ONLY on active compact pills! */}
      <div className="subagents-hud-layer">
        {renderSubs.map((sub) => {
          const pos = hudPositions[sub.id];
          if (!pos) return null;
          const schemeColor = SCHEME_COLORS[sub.scheme] || 'var(--accent)';
          const pct = sub.exiting
            ? 100
            : typeof sub.progressPercent === 'number'
            ? Math.min(100, Math.max(8, sub.progressPercent))
            : null;
          const isSleeping = sub.status === 'WAITING';
          const pillBorderColor =
            sub.exiting || sub.status === 'DONE'
              ? 'rgba(52, 211, 153, 0.7)'
              : isSleeping
              ? 'rgba(129, 140, 248, 0.55)'
              : `${schemeColor}99`;
          const barColor =
            sub.status === 'DONE'
              ? 'var(--emerald)'
              : isSleeping
              ? '#818cf8'
              : schemeColor;
          return (
            <div
              key={sub.id}
              className={`subagent-hud-card ${sub.status === 'DONE' ? 'is-done' : ''} ${isSleeping ? 'is-sleeping' : ''} ${sub.exiting ? 'is-exiting' : ''}`}
              style={{ left: `${pos.x}px`, top: `${pos.y}px` }}
            >
              <div
                className="subagent-hud-pill"
                data-pet-interactive={sub.exiting ? undefined : 'true'}
                style={{ borderColor: pillBorderColor }}
                onClick={
                  sub.exiting
                    ? undefined
                    : () => {
                        const ent = subCtlsRef.current.get(sub.id);
                        if (ent?.ctl && sub.status !== 'WAITING') {
                          ent.ctl.doWord?.('wave');
                          ent.ctl.setExpr?.('wink', 1.6);
                        }
                      }
                }
                title={`${sub.name} (${sub.role}) · ${sub.progressText}`}
              >
                <div className="subagent-hud-top">
                  <span
                    className={`subagent-status-indicator ${sub.status.toLowerCase()}`}
                    style={{ backgroundColor: barColor }}
                  />
                  <span className="subagent-name-tag">{sub.name}</span>
                  <span className="subagent-role-tag">{isSleeping ? '💤 休眠' : sub.role}</span>
                </div>
                <div className="subagent-progress-row">
                  <div className="subagent-progress-meta">
                    <span className="subagent-progress-text">{sub.progressText}</span>
                    {pct !== null && <span className="subagent-pct-label">{pct}%</span>}
                  </div>
                  {pct !== null && (
                    <div className="subagent-bar-bg">
                      <div
                        className="subagent-bar-fill"
                        style={{
                          width: `${pct}%`,
                          backgroundColor: barColor,
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
