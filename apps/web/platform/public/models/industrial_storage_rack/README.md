# Industrial Storage Rack 3D Model

## Attribution

**Title:** Industrial Storage Rack
**Author:** siddharthkalbage (https://sketchfab.com/siddharthkalbage)
**License:** CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
**Source:** https://sketchfab.com/3d-models/industrial-storage-rack-c21c9a687c3d48ad9e74f894c6d2791c

## Files

- `scene.gltf` - GLTF 3D model file
- `scene.bin` - Binary data for the model
- `textures/` - Texture files for the model
  - `Solid_Glass_baseColor.jpeg` - Base color texture
  - `Solid_Glass_metallicRoughness.png` - Metallic and roughness texture
  - `Solid_Glass_normal.png` - Normal map texture
- `license.txt` - Original license file

## Usage

This model is used in the Warehouse 3D Map component to represent industrial storage racks in the warehouse visualization.

The model is loaded using `@react-three/drei`'s `useGLTF` hook and is automatically used for locations with `type: 'rack'`.
