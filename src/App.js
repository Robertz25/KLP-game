import { useState } from "react";
import heic2any from "heic2any";
import "./styles.css";

export default function App() {
  const [base64Image, setBase64Image] = useState();
  const [displayImage, setDisplayImage] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleImageConversion = async (file) => {
    let blob;

    // Check MIME type
    const allowedMimeTypes = ["image/jpeg", "application/pdf", "image/png", "application/octet-stream"];
    if (allowedMimeTypes.includes(file.type) || file.type === "application/octet-stream" || file.type === "image/heic") {
      // For allowed types, no conversion needed
      blob = file;
    } else {
      // Convert HEIC to JPEG
      try {
        let blobRes = await fetch(URL.createObjectURL(file));
        blob = await blobRes.blob();
        blob = await heic2any({
          blob,
          toType: "image/jpeg",
          quality: 1
        });
      } catch (error) {
        console.error("Error converting HEIC to JPEG:", error);
        setErrorMessage("Error converting HEIC to JPEG. Please upload a valid image.");
        return null;
      }
    }

    return blob;
  };

  const handleImageUpload = async (event) => {
    const file = event.target.files[0];
    const convertedBlob = await handleImageConversion(file);

    if (!convertedBlob) {
      setErrorMessage("Unsupported file format. Please upload a valid image.");
      return;
    }

    // Convert the blob to Base64
    const reader = new FileReader();
    reader.readAsDataURL(convertedBlob);
    reader.onloadend = () => {
      let base64Data = reader.result.split(",")[1]; // Exclude data URI prefix
      setBase64Image(base64Data);
      setDisplayImage(true);
      // Send Base64 data in a POST request
      fetch("/api/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ image: base64Data })
      });
    };
  };

  return (
    <div className="App">
      <img className="fish fish--small" src="/fish.svg" alt="" aria-hidden="true" />
      <img className="fish fish--medium" src="/fish.svg" alt="" aria-hidden="true" />
      <img className="fish fish--large" src="/fish.svg" alt="" aria-hidden="true" />
      <h1>Convert HEIC to JPEG and Base64</h1>
      <input type="file" onChange={handleImageUpload} accept="image/*,.heic,.pdf" />
      {errorMessage && <p style={{ color: "red" }}>{errorMessage}</p>}
      {displayImage && base64Image && (
        <div>
          <h2>Base64 Encoded Image:</h2>
          <textarea value={base64Image} readOnly rows={10} cols={50} />
          <h2>Download Converted Image:</h2>
          <a
            href={`data:image/jpeg;base64,${base64Image}`}
            download="converted_image.jpg"
          >
            Download Image
          </a>
        </div>
      )}
    </div>
  );
}
