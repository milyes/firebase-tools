import { Bucket } from "@google-cloud/storage";
import { expect } from "chai";
import * as admin from "firebase-admin";
import * as fs from "fs";
import * as supertest from "supertest";
import { TEST_ENV } from "./env";

import { EmulatorEndToEndTest } from "../../integration-helpers/framework";
import {
  EMULATORS_SHUTDOWN_DELAY_MS,
  resetStorageEmulator,
  getTmpDir,
  TEST_SETUP_TIMEOUT,
  createRandomFile,
} from "../utils";

const TEST_FILE_NAME = "testing/storage_ref/image.png";
const ENCODED_TEST_FILE_NAME = "testing%2Fstorage_ref%2Fimage.png";

// TODO(b/241151246): Fix conformance tests.
// TODO(b/242314185): add more coverage.
describe("Firebase Storage endpoint conformance tests", () => {
  // Temp directory to store generated files.
  const tmpDir = getTmpDir();
  const smallFilePath = createRandomFile("small_file", 10, tmpDir);

  const firebaseHost = TEST_ENV.firebaseHost;
  const storageBucket = TEST_ENV.appConfig.storageBucket;

  let test: EmulatorEndToEndTest;
  let testBucket: Bucket;
  let authHeader: { Authorization: string };

  async function resetState(): Promise<void> {
    if (TEST_ENV.useProductionServers) {
      await testBucket.deleteFiles();
    } else {
      await resetStorageEmulator(TEST_ENV.storageEmulatorHost);
    }
  }

  before(async function (this) {
    this.timeout(TEST_SETUP_TIMEOUT);
    TEST_ENV.applyEnvVars();
    if (!TEST_ENV.useProductionServers) {
      test = new EmulatorEndToEndTest(TEST_ENV.fakeProjectId, __dirname, TEST_ENV.emulatorConfig);
      await test.startEmulators(["--only", "auth,storage"]);
    }

    // Init GCS admin SDK. Used for easier set up/tear down.
    const credential = TEST_ENV.prodServiceAccountKeyJson
      ? admin.credential.cert(TEST_ENV.prodServiceAccountKeyJson)
      : admin.credential.applicationDefault();
    admin.initializeApp({ credential });
    testBucket = admin.storage().bucket(storageBucket);
    authHeader = { Authorization: `Bearer ${await TEST_ENV.adminAccessTokenGetter}` };
  });

  after(async function (this) {
    this.timeout(EMULATORS_SHUTDOWN_DELAY_MS);
    admin.app().delete();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    TEST_ENV.removeEnvVars();
    if (!TEST_ENV.useProductionServers) {
      await test.stopEmulators();
    }
  });

  beforeEach(async () => {
    await resetState();
  });

  describe("multipart upload", () => {
    it("should return an error message when uploading a file with invalid content type", async () => {
      const res = await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/?name=${ENCODED_TEST_FILE_NAME}`)
        .set(authHeader)
        .set({ "x-goog-upload-protocol": "multipart", "content-type": "foo" })
        .send()
        .expect(400);
      expect(res.text).to.include("Bad content type.");
    });
  });

  describe("resumable upload", () => {
    describe("upload", () => {
      it("should accept subsequent resumable upload commands without an auth header", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o?uploadType=resumable&name=${TEST_FILE_NAME}`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .send()
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          // No Authorization required in upload
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "upload",
            "X-Goog-Upload-Offset": 0,
          })
          .send()
          .expect(200);
        const uploadStatus = await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          // No Authorization required in finalize
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "finalize",
          })
          .expect(200)
          .then((res) => res.header["x-goog-upload-status"]);

        expect(uploadStatus).to.equal("final");

        await supertest(firebaseHost)
          .get(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}`)
          .set(authHeader)
          .expect(200);
      });

      it("should handle resumable uploads with an empty buffer", async () => {
        const uploadUrl = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?uploadType=resumable`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .send({})
          .expect(200)
          .then((res) => {
            return new URL(res.header["x-goog-upload-url"]);
          });

        const finalizeStatus = await supertest(firebaseHost)
          .post(uploadUrl.pathname + uploadUrl.search)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "finalize",
          })
          .send({})
          .expect(200)
          .then((res) => res.header["x-goog-upload-status"]);
        expect(finalizeStatus).to.equal("final");
      });

      it("should return 403 when resumable upload is unauthenticated", async () => {
        const testFileName = "disallowSize0";
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${testFileName}?uploadType=resumable`)
          // Authorization missing
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": 0,
          })
          .expect(403);
      });

      it("should return 400 when calling finalize on an already finalized resumable upload", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(
            `/v0/b/${storageBucket}/o/test_upload.jpg?uploadType=resumable&name=test_upload.jpg`
          )
          .set({
            Authorization: "Bearer owner",
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": 0,
          })
          .expect(200);

        const uploadStatus = await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "finalize",
          })
          .expect(400)
          .then((res) => res.header["x-goog-upload-status"]);

        expect(uploadStatus).to.equal("final");
      });
    });

    describe("cancel", () => {
      it("should cancel upload successfully", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?uploadType=resumable`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));
        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "cancel",
          })
          .expect(200);

        await supertest(firebaseHost)
          .get(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}`)
          .set(authHeader)
          .expect(404);
      });

      it("should return 200 when cancelling already cancelled upload", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?uploadType=resumable`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "cancel",
          })
          .expect(200);

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "cancel",
          })
          .expect(200);
      });

      it("should return 400 when cancelling finalized resumable upload", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?uploadType=resumable`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "upload, finalize",
            "X-Goog-Upload-Offset": 0,
          })
          .expect(200);

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "cancel",
          })
          .expect(400);
      });

      it("should return 404 when cancelling non-existent upload", async () => {
        const uploadURL = await supertest(firebaseHost)
          .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?uploadType=resumable`)
          .set(authHeader)
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "start",
          })
          .expect(200)
          .then((res) => new URL(res.header["x-goog-upload-url"]));

        await supertest(firebaseHost)
          .put(uploadURL.pathname + uploadURL.search.replace(/(upload_id=).*?(&)/, "$1foo$2"))
          .set({
            "X-Goog-Upload-Protocol": "resumable",
            "X-Goog-Upload-Command": "cancel",
          })
          .expect(404);
      });
    });
  });

  describe("tokens", () => {
    it("should generate new token on create_token", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=true`)
        .set(authHeader)
        .expect(200)
        .then((res) => {
          const metadata = res.body;
          expect(metadata.downloadTokens.split(",").length).to.deep.equal(1);
        });
    });

    it("should return a 400 if create_token value is invalid", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=someNonTrueParam`)
        .set(authHeader)
        .expect(400);
    });

    it("should return a 403 for create_token if auth header is invalid", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=true`)
        .set({ Authorization: "Bearer somethingElse" })
        .expect(403);
    });

    it("should delete a download token", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=true`)
        .set(authHeader)
        .expect(200);
      const tokens = await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=true`)
        .set(authHeader)
        .expect(200)
        .then((res) => res.body.downloadTokens.split(","));
      // delete the newly added token
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?delete_token=${tokens[0]}`)
        .set(authHeader)
        .expect(200)
        .then((res) => {
          const metadata = res.body;
          expect(metadata.downloadTokens.split(",")).to.deep.equal([tokens[1]]);
        });
    });

    it("should regenerate a new token if the last remaining one is deleted", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?create_token=true`)
        .set(authHeader)
        .expect(200);
      const token = await supertest(firebaseHost)
        .get(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}`)
        .set(authHeader)
        .expect(200)
        .then((res) => res.body.downloadTokens);

      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?delete_token=${token}`)
        .set(authHeader)
        .expect(200)
        .then((res) => {
          const metadata = res.body;
          expect(metadata.downloadTokens.split(",").length).to.deep.equal(1);
          expect(metadata.downloadTokens.split(",")).to.not.deep.equal([token]);
        });
    });

    it("should return a 403 for delete_token if auth header is invalid", async () => {
      await supertest(firebaseHost)
        .post(`/v0/b/${storageBucket}/o/${ENCODED_TEST_FILE_NAME}?delete_token=someToken`)
        .set({ Authorization: "Bearer somethingElse" })
        .expect(403);
    });
  });
});
