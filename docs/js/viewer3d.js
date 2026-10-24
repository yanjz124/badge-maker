// Minimal three.js viewer for built plates: flat-shaded parts in filament colors on a
// build-plate square. Renders on demand (only when the view changes).
import * as THREE from "three";
import { OrbitControls } from "../vendor/three/OrbitControls.js";

export class Viewer {
  constructor(container) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    container.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.5, 5000);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", () => this.render());
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x666666, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.6, -1, 1.6);
    this.scene.add(sun);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.framedKey = null;
    new ResizeObserver(() => this.resize()).observe(container);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /** objects: layoutPlates() objects; colors: {1: "#hex", 2: "#hex"}; bed: mm. */
  show(objects, colors, bed) {
    for (const c of [...this.group.children]) {
      this.group.remove(c);
      c.geometry?.dispose();
      c.material?.dispose();
    }
    const min = new THREE.Vector3(Infinity, Infinity, Infinity), max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    for (const o of objects) {
      for (const p of o.parts) {
        const g = new THREE.BufferGeometry();
        g.setAttribute("position", new THREE.BufferAttribute(p.mesh.positions, 3));
        g.setIndex(new THREE.BufferAttribute(p.mesh.indices, 1));
        const flat = g.toNonIndexed();
        g.dispose();
        flat.computeVertexNormals();
        flat.computeBoundingBox();
        min.min(flat.boundingBox.min);
        max.max(flat.boundingBox.max);
        const mat = new THREE.MeshStandardMaterial({ color: colors[p.slot] || "#888", roughness: 0.55, metalness: 0.05 });
        this.group.add(new THREE.Mesh(flat, mat));
      }
    }
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(bed, bed),
      new THREE.MeshStandardMaterial({ color: 0x8a8f98, roughness: 0.9, transparent: true, opacity: 0.35 }));
    plate.position.set(bed / 2, bed / 2, -0.05);
    this.group.add(plate);

    // Re-frame only when the set of objects changes size, so edits keep the user's view.
    const key = `${objects.length}:${Math.round(max.x - min.x)}x${Math.round(max.y - min.y)}`;
    if (key !== this.framedKey && isFinite(min.x)) {
      this.framedKey = key;
      const c = min.clone().add(max).multiplyScalar(0.5);
      const r = Math.max(max.x - min.x, max.y - min.y) * 0.5;
      this.controls.target.copy(c);
      this.camera.position.set(c.x, c.y - r * 2.2, c.z + r * 2.0);
      this.controls.update();
    }
    this.resize();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
