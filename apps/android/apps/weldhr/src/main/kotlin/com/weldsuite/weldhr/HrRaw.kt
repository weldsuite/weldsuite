package com.weldsuite.weldhr

import kotlinx.serialization.Serializable
import okhttp3.MultipartBody
import okhttp3.ResponseBody
import retrofit2.Response
import retrofit2.http.GET
import retrofit2.http.Multipart
import retrofit2.http.POST
import retrofit2.http.Part
import retrofit2.http.Path
import retrofit2.http.Streaming
import retrofit2.http.Url

/**
 * The calls weldhr.yaml can't describe, through the same `ApiClient` (token,
 * `X-Weld-App`, `X-Weld-Workspace`): the contract checker reads JSON only,
 * so the receipt upload (multipart) and the files the app opens (a receipt,
 * a payslip, an annual statement) are here; and `GET /api/me/permissions`,
 * which the server's binary serves rather than the WeldHR module (could move
 * to core.yaml).
 */
interface HrRawApi {
    @GET("api/me/permissions")
    suspend fun permissions(): Response<PermissionsEnvelope>

    /** A file under `/api`, e.g. `api/weldhr/me/payslips/ps_1/pdf`. */
    @Streaming
    @GET
    suspend fun download(@Url path: String): Response<ResponseBody>

    @Multipart
    @POST("api/weldhr/me/declarations/{id}/receipt")
    suspend fun uploadReceipt(@Path("id") id: String, @Part file: MultipartBody.Part): Response<ResponseBody>
}

@Serializable
data class PermissionsEnvelope(val data: PermissionsBody)

/** The caller's effective permissions in the workspace; denies always win. */
@Serializable
data class PermissionsBody(
    val permissions: List<String> = emptyList(),
    val denies: List<String> = emptyList(),
)
