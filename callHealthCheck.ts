import axios from 'axios';
import https from 'https';

const {
    FULL_URL,
    API_KEY
} = process.env;

exports.callHealthCheck = async function(){
        console.log(`Timer Function Called`)
        var url =  FULL_URL;
        const agent = new https.Agent({
            rejectUnauthorized: false
        });
        var options = {
            httpsAgent: agent,
            headers: {
                Authorization: 'Bearer ' +  API_KEY
            }
        };
        try {
            console.log(`Calling ${FULL_URL}`)
            const response = await axios.get(url, options);
            console.log(response.data)
            return response.data;
        } catch (err) {
            throw console.error(`Error retrieving VIP data from Fortigate: ${url}. Error : ${err} `);
        }
    }
if (module === require.main) {
    exports.callHeallthCheck(console.log);
}