import axios from "axios";

const api = axios.create({
    baseURL: import.meta.env.VITE_BASEURL || "http://localhost:5000",
    headers: {
        "Content-Type": "application/json",
    },
});

export default api;