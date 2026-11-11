import { Mesh, Program, Renderer, Triangle } from "ogl";
import { useEffect, useRef } from "react";

const VERTEX = /* glsl */ `
attribute vec2 position;
attribute vec2 uv;
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position, 0.0, 1.0); }
`;

// Slow curtains of light: two value-noise fields bent by time, tinted from deep ink to sea glass.
const FRAGMENT = /* glsl */ `
precision highp float;
uniform float uTime;
uniform vec2 uResolution;
uniform vec3 uInk;
uniform vec3 uGlass;
uniform vec3 uTide;
varying vec2 vUv;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
  return v;
}
void main() {
  vec2 uv = vUv;
  uv.x *= uResolution.x / uResolution.y;
  float t = uTime * 0.035;
  float bend = fbm(vec2(uv.x * 1.4 + t, t * 0.6)) * 0.55;
  float band = smoothstep(0.32, 0.0, abs(uv.y - 0.72 - bend + 0.25));
  float band2 = smoothstep(0.22, 0.0, abs(uv.y - 0.52 - fbm(vec2(uv.x * 2.1 - t * 1.3, 4.0)) * 0.45 + 0.18));
  float shimmer = fbm(vec2(uv.x * 6.0, uv.y * 1.5 - t * 2.0));
  vec3 colour = uInk;
  colour = mix(colour, uTide, band2 * (0.55 + 0.45 * shimmer) * 0.55);
  colour = mix(colour, uGlass, band * (0.45 + 0.55 * shimmer) * 0.5);
  float vignette = smoothstep(1.25, 0.25, length(vUv - vec2(0.5, 0.65)));
  colour *= mix(0.7, 1.0, vignette);
  gl_FragColor = vec4(colour, 1.0);
}
`;

const DARK = { ink: [0.043, 0.098, 0.13], glass: [0.31, 0.78, 0.71], tide: [0.2, 0.36, 0.62] };
const LIGHT = { ink: [0.95, 0.965, 0.96], glass: [0.55, 0.86, 0.8], tide: [0.7, 0.8, 0.95] };

/**
 * The landing page background. Capped at 30 fps and a device pixel ratio of 1.5, paused when the tab is
 * hidden or the canvas is off screen, and drawn once (no animation) when the person prefers reduced motion.
 */
export function Aurora({ theme }: { theme: "dark" | "light" }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let renderer: Renderer;
    try {
      renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio, 1.5), alpha: false, antialias: false });
    } catch {
      return; // no WebGL: the CSS gradient behind stays visible
    }
    const gl = renderer.gl;
    gl.canvas.setAttribute("aria-hidden", "true");
    gl.canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    element.appendChild(gl.canvas);

    const palette = theme === "dark" ? DARK : LIGHT;
    const program = new Program(gl, {
      vertex: VERTEX,
      fragment: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uResolution: { value: [1, 1] },
        uInk: { value: palette.ink },
        uGlass: { value: palette.glass },
        uTide: { value: palette.tide },
      },
    });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program });

    const resize = () => {
      renderer.setSize(element.clientWidth, element.clientHeight);
      program.uniforms.uResolution!.value = [element.clientWidth, element.clientHeight];
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(element);

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    let visible = true;
    let frame = 0;
    let last = 0;
    const start = performance.now();
    const draw = (now: number) => {
      program.uniforms.uTime!.value = (now - start) / 1000 + 40;
      renderer.render({ scene: mesh });
    };
    const loop = (now: number) => {
      frame = requestAnimationFrame(loop);
      if (now - last < 1000 / 30) return;
      last = now;
      draw(now);
    };
    const run = () => {
      cancelAnimationFrame(frame);
      if (reduce.matches) draw(start + 12_000);
      else if (visible && document.visibilityState === "visible") frame = requestAnimationFrame(loop);
    };
    const intersection = new IntersectionObserver(([entry]) => {
      visible = Boolean(entry?.isIntersecting);
      run();
    });
    intersection.observe(element);
    document.addEventListener("visibilitychange", run);
    reduce.addEventListener("change", run);
    run();

    return () => {
      cancelAnimationFrame(frame);
      intersection.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", run);
      reduce.removeEventListener("change", run);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      gl.canvas.remove();
    };
  }, [theme]);

  return <div ref={host} className="absolute inset-0 overflow-hidden" />;
}
