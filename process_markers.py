import cv2
import numpy as np
import os
import shutil

# Inputs
artifact_dir = r"C:\Users\ThinkPad P15s\.gemini\antigravity-ide\brain\ffef5af3-f08a-4adc-81a7-22dba4a0a245"
assets_dir = r"E:\vehiclemoment\vehiclemoment\assets\markers"

generated_files = {
    "car": "realistic_car_top_down_1784799776360.png",
    "truck": "realistic_truck_top_down_1784799800338.png",
    "bus": "realistic_bus_top_down_1784799811983.png",
    "bike": "realistic_bike_top_down_1784799823174.png",
    "auto": "realistic_auto_top_down_1784799858690.png",
    "suv": "realistic_suv_top_down_1784799836558.png"
}

target_size = (96, 96)

def remove_white_bg(img_path):
    img = cv2.imread(img_path, cv2.IMREAD_UNCHANGED)
    if img is None:
        print(f"Failed to load {img_path}")
        return None
    
    if img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA, cv2.COLOR_BGR)
        
    # Convert to grayscale and threshold to find the white background
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    _, mask = cv2.threshold(gray, 240, 255, cv2.THRESH_BINARY_INV)
    
    # Clean up mask
    kernel = np.ones((3,3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)
    
    # Add alpha channel
    b, g, r = cv2.split(img)
    rgba = cv2.merge([b, g, r, mask])
    
    # Crop to bounding box
    coords = cv2.findNonZero(mask)
    if coords is not None:
        x, y, w, h = cv2.boundingRect(coords)
        rgba = rgba[y:y+h, x:x+w]
        
    # Resize keeping aspect ratio
    h, w = rgba.shape[:2]
    max_dim = max(h, w)
    scale = target_size[0] / max_dim
    new_w = int(w * scale)
    new_h = int(h * scale)
    resized = cv2.resize(rgba, (new_w, new_h), interpolation=cv2.INTER_AREA)
    
    # Pad to square target_size
    pad_w = (target_size[0] - new_w) // 2
    pad_h = (target_size[1] - new_h) // 2
    canvas = np.zeros((target_size[1], target_size[0], 4), dtype=np.uint8)
    canvas[pad_h:pad_h+new_h, pad_w:pad_w+new_w] = resized
    
    return canvas

def add_glow(img, color_bgr):
    canvas = np.zeros((128, 128, 4), dtype=np.uint8)
    # Center the 96x96 image in 128x128
    offset = 16
    canvas[offset:offset+96, offset:offset+96] = img
    
    # Extract alpha channel to find contour
    alpha = canvas[:, :, 3]
    contours, _ = cv2.findContours(alpha, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    
    glow_canvas = np.zeros((128, 128, 4), dtype=np.uint8)
    cv2.drawContours(glow_canvas, contours, -1, color_bgr + (255,), 6)
    
    # Blur the contour to create a glow
    glow = cv2.GaussianBlur(glow_canvas, (15, 15), 0)
    
    # Merge original image over the glow
    mask = canvas[:, :, 3] > 0
    glow[mask] = canvas[mask]
    
    return glow

print("Processing vehicle markers...")
for name, filename in generated_files.items():
    path = os.path.join(artifact_dir, filename)
    if os.path.exists(path):
        processed = remove_white_bg(path)
        if processed is not None:
            out_path = os.path.join(assets_dir, f"veh_{name}.png")
            cv2.imwrite(out_path, processed)
            print(f"Saved {out_path}")

# Missing ones fallback (van -> suv, excavator -> truck)
if os.path.exists(os.path.join(assets_dir, "veh_suv.png")):
    shutil.copy(os.path.join(assets_dir, "veh_suv.png"), os.path.join(assets_dir, "veh_van.png"))
if os.path.exists(os.path.join(assets_dir, "veh_truck.png")):
    shutil.copy(os.path.join(assets_dir, "veh_truck.png"), os.path.join(assets_dir, "veh_excavator.png"))

print("Processing state markers...")
car_img_path = os.path.join(assets_dir, "veh_car.png")
if os.path.exists(car_img_path):
    car_img = cv2.imread(car_img_path, cv2.IMREAD_UNCHANGED)
    
    states = {
        "running": (45, 211, 39),    # #27D34D Green
        "stopped": (68, 68, 239),    # #EF4444 Red
        "idle": (0, 165, 255),       # #FFA500 Orange
        "inactive": (170, 170, 170), # #AAAAAA Gray
        "expired": (51, 51, 51),     # #333333 Dark Gray
        "no_data": (200, 200, 200)   # Light Gray
    }
    
    for state, color in states.items():
        glow_img = add_glow(car_img, color)
        out_path = os.path.join(assets_dir, f"car_{state}.png")
        cv2.imwrite(out_path, glow_img)
        print(f"Saved {out_path}")

print("Done!")
