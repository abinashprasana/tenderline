import {
  AnimationClip,
  AnimationMixer,
  AnimationUtils,
  Box3,
  DirectionalLight,
  HemisphereLight,
  LoopOnce,
  LoopRepeat,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  Vector3,
  WebGLRenderer,
  type AnimationAction,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

import { FEET_FROM_BOTTOM, STAGE_SIZE } from "./flight";

const MODEL_URL = "/models/wren.gltf";
const FRAME_MS = 1000 / 30;

/**
 * The three.js side of Wren: one small transparent canvas with the owl, its animation clips and lights.
 * It knows nothing about the page; the React component moves the canvas around. Loaded on demand, so
 * three.js never reaches the landing page.
 */
export class WrenStage {
  private renderer: WebGLRenderer;
  private scene = new Scene();
  private camera = new PerspectiveCamera(26, 1, 0.01, 50);
  private mixer: AnimationMixer | null = null;
  private actions = new Map<string, AnimationAction>();
  private current: AnimationAction | null = null;
  private model: Object3D | null = null;
  private head: Object3D | null = null;
  private frame = 0;
  private last = 0;
  private yaw = 0;
  private yawTarget = 0;
  private look = { x: 0, y: 0 };
  private lookTarget = { x: 0, y: 0 };
  private disposed = false;
  private stillAction: AnimationAction | null = null;
  private blinkAction: AnimationAction | null = null;
  private nextBlink = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "low-power" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(STAGE_SIZE, STAGE_SIZE, false);
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    const key = new DirectionalLight(0xffffff, 2.4);
    key.position.set(1.5, 2.5, 3);
    const rim = new DirectionalLight(0x9ff3e6, 2.2);
    rim.position.set(-2, 1.5, -2.5);
    this.scene.add(new HemisphereLight(0xffffff, 0x5a7a80, 1.1), key, rim);
  }

  /** Loads the owl. Rejects if the model or WebGL is unavailable, and the flat Wren stays. */
  async load(): Promise<void> {
    const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
    if (this.disposed) return;
    this.model = gltf.scene;
    this.scene.add(gltf.scene);
    this.head = gltf.scene.getObjectByName("Head") ?? null;

    // Frame the owl so its feet sit at a known height in the canvas, with room above for wings and hops.
    const box = new Box3().setFromObject(gltf.scene);
    const size = box.getSize(new Vector3());
    const visible = size.y * 1.62;
    const distance = visible / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const lookY = box.min.y + visible * (0.5 - FEET_FROM_BOTTOM);
    this.camera.position.set(0, lookY, distance);
    this.camera.lookAt(0, lookY, 0);

    this.mixer = new AnimationMixer(gltf.scene);
    for (const clip of gltf.animations) this.actions.set(clip.name, this.mixer.clipAction(clip));

    // "still": the idle pose held without its sway, and a separate blink lifted from the idle clip's
    // eyelid track, so a resting Wren does nothing but blink now and then.
    const idle = gltf.animations.find((clip) => clip.name === "idle");
    if (idle) {
      const lids = idle.tracks.filter((track) => track.name.startsWith("Lids."));
      const body = idle.tracks.filter((track) => !track.name.startsWith("Lids."));
      this.stillAction = this.mixer.clipAction(new AnimationClip("still", idle.duration, body));
      this.actions.set("still", this.stillAction);
      if (lids.length > 0) {
        const blink = AnimationUtils.subclip(new AnimationClip("lids", idle.duration, lids), "blink", 22, 29, 30);
        this.blinkAction = this.mixer.clipAction(blink);
        this.blinkAction.setLoop(LoopOnce, 1);
      }
    }
    this.play("still", true);
    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** Cross-fades to a clip. A clip that does not loop holds its last pose until the next one. */
  play(name: string, loop: boolean): void {
    const next = this.actions.get(name);
    if (!next || !this.mixer) return;
    if (next === this.current && loop) return;
    next.reset();
    next.setLoop(loop ? LoopRepeat : LoopOnce, loop ? Infinity : 1);
    next.clampWhenFinished = !loop;
    if (this.current && this.current !== next) next.crossFadeFrom(this.current, 0.18, false);
    next.play();
    // The still pose is one frozen frame; everything else runs at normal speed.
    next.timeScale = next === this.stillAction ? 0 : 1;
    this.current = next;
    this.nextBlink = performance.now() + 2500;
  }

  /** Turns the body: 0 faces the viewer, positive turns toward the right of the screen. */
  face(yaw: number): void {
    this.yawTarget = yaw;
  }

  /** Turns the head toward a point, each axis from -1 to 1. */
  lookAt(x: number, y: number): void {
    this.lookTarget = { x, y };
  }

  private tick = (now: number): void => {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.tick);
    const elapsed = now - this.last;
    if (elapsed < FRAME_MS || document.hidden) return;
    this.last = now;
    const dt = Math.min(elapsed / 1000, 0.1);
    if (this.current === this.stillAction && this.blinkAction && now > this.nextBlink) {
      this.blinkAction.reset().play();
      this.nextBlink = now + 6000 + Math.random() * 4000;
    }
    this.mixer?.update(dt);
    const follow = Math.min(1, dt * 9);
    this.yaw += (this.yawTarget - this.yaw) * follow;
    this.look.x += (this.lookTarget.x - this.look.x) * follow;
    this.look.y += (this.lookTarget.y - this.look.y) * follow;
    if (this.model) this.model.rotation.y = this.yaw;
    // The clips drive the head each frame, so the glance is added on top after the mixer has run.
    if (this.head) {
      this.head.rotation.y += this.look.x * 0.55;
      this.head.rotation.x += this.look.y * 0.3;
    }
    this.renderer.render(this.scene, this.camera);
  };

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.mixer?.stopAllAction();
    this.renderer.dispose();
  }
}
